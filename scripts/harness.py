"""Perception + execution harness for JEV Web Control.

Reuses jev-ultrafast's ``browser_harness`` for a single CDP daemon/session, then
extends observation so that:

* the injected ``snapshot_extended.js`` collects elements across **open shadow
  roots** and **same-origin iframes** from the main execution context (verified);
* **cross-origin iframes** (out-of-process frames) are merged by attaching to
  each frame target via CDP and running the snapshot there too, tagging every
  action with a ``scope`` (path) and ``context`` (execution context id) so the
  locator layer can later resolve and re-find the element.

Every model-facing node id stays a real DOM reference owned by the browser
(``window.__jevFast``); we never let the model invent selectors or coordinates.
"""

import hashlib
import json
import sys
import time
from pathlib import Path

from browser_harness.admin import ensure_daemon
from browser_harness.helpers import cdp

READ_STATE = Path(__file__).with_name("snapshot_extended.js").read_text()
MARKER = f"(() => {{ const state={READ_STATE}; return state?.marker ?? null; }})()"


class StalePage(ValueError):
    """A decision no longer refers to the currently observed page."""


def fingerprint(state):
    content = {k: state[k] for k in ("url", "text", "actions", "scroll")}
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


class Browser:
    def __init__(self, url, *, background=True, cross_origin=True):
        ensure_daemon()
        self.target = cdp("Target.createTarget", url="about:blank", background=background)["targetId"]
        # flatten=True gives one session that can drive the main frame; per-frame
        # (OOPIF) sessions are attached separately for cross-origin iframes.
        self.session = cdp("Target.attachToTarget", targetId=self.target, flatten=True)["sessionId"]
        self.call("Emulation.setDeviceMetricsOverride", width=1120, height=780, deviceScaleFactor=1, mobile=False)
        self.call("Emulation.setFocusEmulationEnabled", enabled=True)
        self.call("Page.navigate", url=url)
        self.cross_origin = cross_origin
        self.contexts = {"main": {"session": self.session, "frame": None}}
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.evaluate("document.readyState") == "complete":
                break
            time.sleep(0.02)

    # ---- low-level CDP plumbing ----
    def call(self, method, context="main", **params):
        session = self.contexts[context]["session"]
        return cdp(method, session_id=session, **params)

    def evaluate(self, expression, context="main"):
        response = self.call("Runtime.evaluate", context, expression=expression, returnByValue=True)
        if response.get("exceptionDetails"):
            raise StalePage("Document changed during evaluation")
        return response.get("result", {}).get("value")

    # ---- observation (the perception layer) ----
    def observe(self, screenshot=True):
        # 1) main context snapshot (covers main doc + same-origin iframes + shadow roots)
        try:
            main = self.evaluate(READ_STATE)
        except StalePage:
            main = None
        if main is None:
            raise StalePage("Document is navigating")

        merged = {
            "url": main["url"],
            "title": main["title"],
            "w": main["w"],
            "h": main["h"],
            "text": main["text"],
            "scroll": main["scroll"],
            "actions": [],
            "marker": main["marker"],
            "page_key": {"main": main["page_key"]},
            "guards": {"main": main["guards"]},
            "omitted_actions": main.get("omitted_actions", 0),
        }
        for a in main["actions"]:
            a = dict(a)
            a["context"] = "main"
            merged["actions"].append(a)

        # 2) best-effort cross-origin iframe merge (OOPIF). Not verifiable in CI
        #    without a real browser; wrapped so it never breaks the main path.
        if self.cross_origin:
            try:
                self._merge_cross_origin(merged)
            except Exception as exc:  # pragma: no cover - needs a live browser
                merged["cross_origin_error"] = str(exc)

        merged["fingerprint"] = fingerprint(merged)
        if screenshot:
            merged["screenshot"] = self.call("Page.captureScreenshot", format="jpeg", quality=72)["data"]
        return merged

    def _merge_cross_origin(self, merged):
        """Attach to each OOPIF frame target and fold its snapshot into `merged`."""
        targets = cdp("Target.getTargets")["targetInfos"]
        for t in targets:
            if t.get("type") not in ("page", "iframe"):
                continue
            if t["targetId"] == self.target:
                continue
            try:
                sub = cdp("Target.attachToTarget", targetId=t["targetId"], flatten=False)
            except Exception:
                continue
            ctx = "oop:" + t["targetId"]
            self.contexts[ctx] = {"session": sub["sessionId"], "frame": t["targetId"]}
            try:
                sub_state = cdp(
                    "Runtime.evaluate",
                    session_id=sub["sessionId"],
                    expression=READ_STATE,
                    returnByValue=True,
                ).get("result", {}).get("value")
            except Exception:
                continue
            if not sub_state:
                continue
            host = _host_of(t.get("url", ""))
            prefix = f"frame[{host}]/"
            merged.setdefault("page_key", {})[ctx] = sub_state["page_key"]
            merged.setdefault("guards", {})[ctx] = sub_state["guards"]
            for a in sub_state["actions"]:
                a = dict(a)
                a["context"] = ctx
                a["scope"] = prefix + (a.get("scope") or "")
                merged["actions"].append(a)

    # ---- freshness (the guard that makes execution safe) ----
    def fresh(self, page, action=None):
        if action is not None and action["kind"] in {"click", "select"}:
            node = action["node"]
            if not isinstance(node, int):
                return False
            ctx = action.get("context", "main")
            current = self.evaluate(
                "(() => { const c=window.__jevFast; "
                f"return c ? [c.pageKey(),c.guard(c.nodes.get({node}))] : null; }})()",
                context=ctx,
            )
            guards = page["guards"].get(ctx, {})
            return current == [page["page_key"].get(ctx), guards.get(str(node))]
        return self.evaluate(MARKER) == page["marker"]

    # ---- execution (code-owned node ids only) ----
    def act(self, action, page, text=None):
        if not self.fresh(page, action):
            raise StalePage("Page changed since this decision. Observe again.")
        if action["kind"] == "wait":
            time.sleep(0.1)
            return {"executed": action["id"]}

        ctx = action.get("context", "main")
        node = action["node"]
        if not isinstance(node, int):
            raise ValueError("Invalid observed node")
        target = self.evaluate(
            """(action => {
              const e=window.__jevFast?.nodes.get(action.node);
              if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-hidden="true"],[inert]') ||
                  !e.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})) return null;
              if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
              const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
              if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
              if (!e.contains(document.elementFromPoint(x,y))) return null;
              if (action.kind==='select') {
                if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
                    !o.disabled && !o.closest('optgroup[disabled]'))) return null;
                e.value=action.value;
                e.dispatchEvent(new Event('input',{bubbles:true}));
                e.dispatchEvent(new Event('change',{bubbles:true}));
              }
              return {x,y};
            })(""" + json.dumps(action) + ")",
            context=ctx,
        )
        if target is None:
            if action["kind"] == "select":
                raise RuntimeError("Dropdown execution was not confirmed; inspect before retrying.")
            raise StalePage("Target changed or is covered. Observe again.")
        if action["kind"] != "select":
            x, y = target["x"], target["y"]
            for event in ("mousePressed", "mouseReleased"):
                self.call("Input.dispatchMouseEvent", ctx, type=event, x=x, y=y, button="left", clickCount=1)
            if action["kind"] == "fill":
                self.call(
                    "Input.dispatchKeyEvent", ctx, type="keyDown", key="a", code="KeyA",
                    modifiers=4 if sys.platform == "darwin" else 2, commands=["selectAll"],
                )
                self.call("Input.dispatchKeyEvent", ctx, type="keyUp", key="a", code="KeyA",
                          modifiers=4 if sys.platform == "darwin" else 2)
                self.call("Input.insertText", ctx, text=text or "")
        return {"executed": action["id"]}

    def close(self):
        if self.target:
            cdp("Target.closeTarget", targetId=self.target)
            self.target = None


def _host_of(url):
    try:
        from urllib.parse import urlparse

        return urlparse(url).netloc or "frame"
    except Exception:
        return "frame"
