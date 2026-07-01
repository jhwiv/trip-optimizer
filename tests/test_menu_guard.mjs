// Tests for the openMenu request-id guard in ItineraryView (src/App.jsx).
//
// The component lives inside the App.jsx monolith and depends on React, so
// we can't import openMenu directly. Instead we reproduce its core async
// shape here \u2014 same `menuReqRef` pattern, same set of state setters, same
// fetch flow \u2014 and exercise the race that the PR closes:
//
//   1. User taps View Menu on restaurant A. /api/menu starts.
//   2. Before A resolves, user taps View Menu on restaurant B.
//   3. A resolves with A's payload. B resolves with B's payload.
//
// Without the guard, A's late resolve would write A's dishes into B's
// modal state (last-write-wins). With the guard, only the current request
// can mutate state. Repo convention: custom assert, prints "N passed, M
// failed", exits non-zero on failure. Auto-discovered by tests/run-all.mjs.

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  \u2713", name); }
  else { failed++; console.log("  \u2717", name, detail); }
}

// ---- reusable test harness ----------------------------------------------
// Mirrors the openMenu / closeMenu shape from ItineraryView. State setters
// are recording mocks so we can assert which writes landed and which were
// suppressed by the request-id guard.

function makeMenuController({ fetchImpl }) {
  const state = {
    menuRestaurant: null,
    menuData: null,
    menuLoading: false,
    menuError: "",
  };
  const writes = []; // ordered log of state mutations
  const set = (key, value) => { state[key] = value; writes.push({ key, value }); };
  const cache = new Map();
  const reqRef = { current: 0 };

  const openMenu = async (restaurant) => {
    if (!restaurant) return;
    const reqId = ++reqRef.current;
    set("menuRestaurant", restaurant);
    set("menuError", "");
    // Inline model-supplied menu shortcut (mirrors the source).
    if (restaurant.menu && (
      (Array.isArray(restaurant.menu.signature_dishes) && restaurant.menu.signature_dishes.length > 0) ||
      (Array.isArray(restaurant.menu.mains) && restaurant.menu.mains.length > 0)
    )) {
      set("menuData", null);
      set("menuLoading", false);
      return;
    }
    const cacheKey = `${restaurant.name}|TEST`;
    const cached = cache.get(cacheKey);
    if (cached) {
      set("menuData", cached);
      set("menuLoading", false);
      return;
    }
    set("menuData", null);
    set("menuLoading", true);
    try {
      const res = await fetchImpl({ name: restaurant.name });
      const json = await res.json();
      // Always cache successful responses even if superseded \u2014 keeps the
      // background work useful for future taps on the same restaurant.
      if (res.ok && json?.menu) cache.set(cacheKey, { menu: json.menu });
      if (reqRef.current !== reqId) return;
      if (!res.ok) set("menuError", json?.error?.message || `Couldn't load the menu (${res.status}).`);
      else if (json?.menu) set("menuData", { menu: json.menu });
      else set("menuError", "Couldn't load the menu.");
    } catch (err) {
      if (reqRef.current !== reqId) return;
      set("menuError", `Couldn't reach the menu service. ${String(err?.message || err).slice(0, 80)}`);
    } finally {
      if (reqRef.current === reqId) set("menuLoading", false);
    }
  };

  const closeMenu = () => {
    reqRef.current++;
    set("menuRestaurant", null);
    set("menuData", null);
    set("menuError", "");
    set("menuLoading", false);
  };

  return { state, writes, cache, reqRef, openMenu, closeMenu };
}

// Deferred-promise fetch mock \u2014 we manually resolve so we can interleave
// requests precisely. Returns a fetch-shaped response object.
function makeDeferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function makeRes(body, { ok = true } = {}) {
  return { ok, json: async () => body };
}

await (async () => {
  // ---- fast re-tap last-write-wins race ---------------------------------
  console.log("=== fast re-tap on second restaurant suppresses first's late write ===");
  {
    const dA = makeDeferred();
    const dB = makeDeferred();
    const ctrl = makeMenuController({
      fetchImpl: async ({ name }) => {
        if (name === "A") return dA.promise;
        if (name === "B") return dB.promise;
        throw new Error(`unexpected ${name}`);
      },
    });

    const pA = ctrl.openMenu({ name: "A" });
    assert("after tap A: menuRestaurant is A", ctrl.state.menuRestaurant?.name === "A");
    assert("after tap A: menuLoading true", ctrl.state.menuLoading === true);
    assert("after tap A: reqRef = 1", ctrl.reqRef.current === 1);

    const pB = ctrl.openMenu({ name: "B" });
    assert("after tap B: menuRestaurant is B (synchronous swap)", ctrl.state.menuRestaurant?.name === "B");
    assert("after tap B: reqRef = 2", ctrl.reqRef.current === 2);

    // A's fetch resolves first with A's payload \u2014 should NOT mutate state.
    dA.resolve(makeRes({ menu: { mains: ["A dish"] } }));
    await pA;
    assert(
      "A's late resolve does NOT overwrite B's menuData",
      ctrl.state.menuData === null,
      `got menuData=${JSON.stringify(ctrl.state.menuData)}`,
    );
    assert(
      "A's late resolve does NOT flip menuLoading off (B is still loading)",
      ctrl.state.menuLoading === true,
    );
    assert(
      "A's payload was still cached for future taps (background work is useful)",
      ctrl.cache.get("A|TEST")?.menu?.mains?.[0] === "A dish",
    );

    // Now B resolves \u2014 should land.
    dB.resolve(makeRes({ menu: { mains: ["B dish"] } }));
    await pB;
    assert("B's resolve writes menuData = B", ctrl.state.menuData?.menu?.mains?.[0] === "B dish");
    assert("B's resolve flips menuLoading to false", ctrl.state.menuLoading === false);
    assert("menuRestaurant still B at end", ctrl.state.menuRestaurant?.name === "B");
  }

  // ---- error from a superseded request doesn't poison the current modal -
  console.log("=== superseded request's error is suppressed ===");
  {
    const dA = makeDeferred();
    const dB = makeDeferred();
    const ctrl = makeMenuController({
      fetchImpl: async ({ name }) => {
        if (name === "A") return dA.promise;
        if (name === "B") return dB.promise;
        throw new Error("nope");
      },
    });

    const pA = ctrl.openMenu({ name: "A" });
    const pB = ctrl.openMenu({ name: "B" });

    // A errors out (network / server failure).
    dA.resolve(makeRes({ error: { message: "A is broken" } }, { ok: false }));
    await pA;
    assert("A's error does NOT set menuError on B's modal", ctrl.state.menuError === "");

    // B resolves cleanly.
    dB.resolve(makeRes({ menu: { mains: ["B"] } }));
    await pB;
    assert("B's success leaves menuError clear", ctrl.state.menuError === "");
    assert("B's success lands menuData", ctrl.state.menuData?.menu?.mains?.[0] === "B");
  }

  // ---- close after open: late fetch must not repopulate dismissed modal -
  console.log("=== closeMenu before fetch resolves suppresses the late write ===");
  {
    const dA = makeDeferred();
    const ctrl = makeMenuController({
      fetchImpl: async ({ name }) => {
        if (name === "A") return dA.promise;
        throw new Error("nope");
      },
    });

    const pA = ctrl.openMenu({ name: "A" });
    assert("after tap A: modal is open", ctrl.state.menuRestaurant?.name === "A");

    ctrl.closeMenu();
    assert("after close: modal cleared", ctrl.state.menuRestaurant === null);
    assert("after close: reqRef bumped past A's id", ctrl.reqRef.current === 2);

    dA.resolve(makeRes({ menu: { mains: ["late A"] } }));
    await pA;
    assert(
      "late A resolve does NOT re-open the dismissed modal",
      ctrl.state.menuRestaurant === null,
    );
    assert("late A resolve does NOT set menuData on a closed modal", ctrl.state.menuData === null);
    assert("late A response was still cached for next time", ctrl.cache.get("A|TEST")?.menu?.mains?.[0] === "late A");
  }

  // ---- same-restaurant re-tap during slow fetch: only the latest counts -
  console.log("=== rapid re-taps on the same restaurant keep only the latest in flight ===");
  {
    const d1 = makeDeferred();
    const d2 = makeDeferred();
    let call = 0;
    const ctrl = makeMenuController({
      fetchImpl: async () => {
        call++;
        return call === 1 ? d1.promise : d2.promise;
      },
    });

    const p1 = ctrl.openMenu({ name: "A" });
    const p2 = ctrl.openMenu({ name: "A" });
    assert("second tap bumped reqRef to 2", ctrl.reqRef.current === 2);

    d1.resolve(makeRes({ menu: { mains: ["first"] } }));
    await p1;
    assert("first slow resolve doesn't land", ctrl.state.menuData === null);
    d2.resolve(makeRes({ menu: { mains: ["second"] } }));
    await p2;
    assert("second resolve lands", ctrl.state.menuData?.menu?.mains?.[0] === "second");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
