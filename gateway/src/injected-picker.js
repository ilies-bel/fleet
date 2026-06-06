/**
 * Bootstrap script injected into every text/html response served through the
 * gateway proxy.  Dormant by default — installs a postMessage listener and
 * waits for { type: 'mars.capture.activate', active: true } from the parent
 * frame before doing anything.  Until activated the previewed app behaves
 * byte-equivalently from the operator's perspective.
 *
 * Origin validation: messages are only honoured when they originate from the
 * dashboard frame (the immediate ancestor). ancestorOrigins[0] is the parent
 * frame's origin in Chromium/WebKit; on Firefox (which lacks ancestorOrigins)
 * the check falls through to the '*' fallback that still requires the correct
 * message type prefix — future slices can tighten this further.
 */

/**
 * Compute a stable CSS reference for a DOM element using a four-step fallback:
 *   1. id present          → { refKind: 'id',     selector: '#id',                label: id }
 *   2. data-testid present → { refKind: 'testid', selector: '[data-testid="…"]',  label: value }
 *   3. aria-label present  → { refKind: 'aria',   selector: '[aria-label="…"]',   label: value }
 *   4. otherwise           → { refKind: 'css',    selector: shortest unique path, label: tagName }
 *
 * Uses el.ownerDocument for uniqueness checks so it works in both a browser
 * context (where ownerDocument === document) and in synthetic DOM environments
 * (linkedom, jsdom) used by unit tests.
 *
 * @param {Element} el
 * @returns {{ refKind: 'id'|'testid'|'aria'|'css', selector: string, label: string }}
 */
export function computeRef(el) {
  if (el.id) {
    return { refKind: 'id', selector: '#' + el.id, label: el.id };
  }
  const testid = el.getAttribute('data-testid');
  if (testid) {
    return { refKind: 'testid', selector: '[data-testid="' + testid + '"]', label: testid };
  }
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    return { refKind: 'aria', selector: '[aria-label="' + ariaLabel + '"]', label: ariaLabel };
  }

  // Build shortest unique CSS path walking up toward body.
  const ownerDoc = el.ownerDocument;
  const parts = [];
  let current = el;
  while (current && current.tagName) {
    const tag = current.tagName.toLowerCase();
    const parent = current.parentElement;
    // Stop at body — body alone is always unique enough as an anchor.
    if (!parent || tag === 'body') {
      parts.unshift(tag);
      break;
    }
    const sameTagSiblings = Array.from(parent.children).filter(
      function(c) { return c.tagName === current.tagName; }
    );
    const idx = sameTagSiblings.indexOf(current) + 1;
    parts.unshift(tag + ':nth-of-type(' + idx + ')');
    const candidate = parts.join(' > ');
    if (ownerDoc.querySelectorAll(candidate).length === 1) {
      break;
    }
    current = parent;
  }
  const selector = parts.join(' > ');
  return { refKind: 'css', selector: selector, label: el.tagName.toLowerCase() };
}

export const INJECTED_PICKER = String.raw`(() => {
  const state = { active: false, captureRoot: null };

  // Resolve expected dashboard origin dynamically so no port is hardcoded.
  // ancestorOrigins[0] is the immediate parent frame's origin (Chromium/WebKit).
  const EXPECTED_DASHBOARD_ORIGIN =
    (window.location.ancestorOrigins && window.location.ancestorOrigins[0]) || '';

  ${computeRef.toString()}

  // Closed shadow root — cached in closure; attachShadow may only be called once
  // per element, so we hold the reference here for subsequent activate/deactivate
  // calls.
  let _shadow = null;

  function ensureRoot() {
    if (_shadow) return _shadow;
    let host = document.getElementById('mars-capture-root');
    if (!host) {
      host = document.createElement('div');
      host.id = 'mars-capture-root';
      document.documentElement.appendChild(host);
    }
    // Expose the overlay host so onCaptureClick can ignore clicks that land on
    // the picker UI rather than treating them as element selections.
    state.captureRoot = host;
    _shadow = host.attachShadow({ mode: 'closed' });
    return _shadow;
  }

  function renderBanner(shadow) {
    shadow.innerHTML =
      '<div style="position:fixed;top:0;left:0;right:0;background:#0b3;color:#fff;' +
      'font:14px system-ui;padding:6px 10px;pointer-events:none;z-index:2147483647">' +
      'Capture mode — click an element to mark it</div>';
  }

  // _hoverHandler holds the registered mousemove handler so uninstall can remove
  // the exact same function reference. _rafId tracks any pending rAF so it can
  // be cancelled on teardown.
  let _hoverHandler = null;
  let _rafId = null;

  // _marked holds {el, rect} pairs so reposition() can update each tint div's
  // position whenever the viewport scrolls or the window resizes.
  let _marked = [];

  function installHoverHighlight(shadow) {
    const hoverDiv = document.createElement('div');
    hoverDiv.id = 'mars-hover';
    hoverDiv.style.cssText =
      'position:fixed;top:0;left:0;pointer-events:none;display:none;box-sizing:border-box;' +
      'outline:2px solid #0b3;background:rgba(0,187,51,0.08)';
    shadow.appendChild(hoverDiv);

    let pendingX = 0, pendingY = 0, rafPending = false;

    _hoverHandler = function(e) {
      pendingX = e.clientX;
      pendingY = e.clientY;
      if (rafPending) return;
      rafPending = true;
      _rafId = requestAnimationFrame(function() {
        rafPending = false;
        _rafId = null;
        const el = document.elementFromPoint(pendingX, pendingY);
        if (!el || el.closest('#mars-capture-root')) {
          hoverDiv.style.display = 'none';
          return;
        }
        const rect = el.getBoundingClientRect();
        hoverDiv.style.display = '';
        hoverDiv.style.transform = 'translate(' + rect.left + 'px,' + rect.top + 'px)';
        hoverDiv.style.width = rect.width + 'px';
        hoverDiv.style.height = rect.height + 'px';
      });
    };

    document.addEventListener('mousemove', _hoverHandler);
  }

  function uninstallHoverHighlight() {
    if (_hoverHandler) {
      document.removeEventListener('mousemove', _hoverHandler);
      _hoverHandler = null;
    }
    if (_rafId !== null) {
      cancelAnimationFrame(_rafId);
      _rafId = null;
    }
  }

  // Walk _marked and write each element's current bounding rect into its tint
  // div. Called once after the tint layer is built and registered as both the
  // scroll (capture) and resize listeners so tints stay aligned on any viewport
  // change.
  function reposition() {
    _marked.forEach(function(item) {
      var r = item.el.getBoundingClientRect();
      item.rect.style.transform = 'translate(' + r.left + 'px,' + r.top + 'px)';
      item.rect.style.width = r.width + 'px';
      item.rect.style.height = r.height + 'px';
    });
  }

  function onCaptureClick(ev) {
    // Ignore clicks that land on the capture-root overlay host (the banner /
    // hover-highlight UI) so the operator can interact with it without
    // accidentally picking it as a target element.
    if (state.captureRoot &&
        (ev.target === state.captureRoot || state.captureRoot.contains(ev.target))) {
      return;
    }
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const ref = computeRef(ev.target);
    window.parent.postMessage({
      type: 'mars.capture.elementPicked',
      refKind: ref.refKind,
      selector: ref.selector,
      route: location.pathname + location.search,
      label: ref.label,
    }, EXPECTED_DASHBOARD_ORIGIN || '*');
  }

  window.addEventListener('message', function(event) {
    // Ignore messages whose type does not start with 'mars.capture.'
    if (
      !event.data ||
      typeof event.data.type !== 'string' ||
      !event.data.type.startsWith('mars.capture.')
    ) {
      return;
    }

    // Validate origin — only honour messages from the dashboard parent frame.
    if (EXPECTED_DASHBOARD_ORIGIN && event.origin !== EXPECTED_DASHBOARD_ORIGIN) {
      return;
    }

    if (event.data.type === 'mars.capture.activate') {
      const wasActive = state.active;
      state.active = !!event.data.active;
      // Register or tear down the capture-phase click listener.
      if (state.active && !wasActive) {
        document.addEventListener('click', onCaptureClick, { capture: true });
      } else if (!state.active && wasActive) {
        document.removeEventListener('click', onCaptureClick, { capture: true });
      }
      // Capture-mode visuals: shadow-DOM banner + hover-highlight overlay.
      const shadow = ensureRoot();
      if (state.active) {
        renderBanner(shadow);
        installHoverHighlight(shadow);

        // Note tint layer — a sibling container for blue note-marker overlays.
        const noteTintLayer = document.createElement('div');
        shadow.appendChild(noteTintLayer);
        const currentRoute = location.pathname + location.search;
        (event.data.notes || []).forEach(function(note) {
          if (note.route !== currentRoute) return;
          if (!note.selector) return;
          let els;
          try { els = document.querySelectorAll(note.selector); } catch (_) { return; }
          Array.from(els).forEach(function(el) {
            const d = document.createElement('div');
            d.style.cssText =
              'position:fixed;top:0;left:0;pointer-events:none;box-sizing:border-box;' +
              'background:rgba(59,130,246,0.12);box-shadow:inset 0 0 0 1px rgba(59,130,246,0.35)';
            noteTintLayer.appendChild(d);
            _marked.push({ el: el, rect: d });
          });
        });
        // Keep tints aligned to their elements on scroll and resize.
        document.addEventListener('scroll', reposition, { capture: true, passive: true });
        window.addEventListener('resize', reposition);
        reposition();
      } else {
        uninstallHoverHighlight();
        document.removeEventListener('scroll', reposition, { capture: true });
        window.removeEventListener('resize', reposition);
        _marked = [];
        shadow.innerHTML = '';
      }
    }
  });

  // Forward Cmd/Ctrl+Shift+K pressed inside the iframe to the parent dashboard
  // so the capture shortcut works regardless of where the operator's focus is.
  window.addEventListener('keydown', function(event) {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      parent.postMessage(
        { type: 'mars.capture.keydown' },
        EXPECTED_DASHBOARD_ORIGIN || '*'
      );
    }
  });
})();`;
