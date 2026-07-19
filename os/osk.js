/* osk.js — the gucOS on-screen keyboard (OSK).
 *
 * Why build-our-own instead of the device IME: VT2 is a canvas with no
 * focusable text input, so a mobile system keyboard never raises — and a
 * hidden-input IME proxy could not express what the OS actually consumes:
 * scancodes + chords (the kernel's Ctrl+Alt+Tab / Ctrl+Esc / GUI+arrow
 * routing, term's ^C control fold, wm.c's ctrl/shift-click). So the OSK
 * SYNTHESIZES keys instead: ONE component, TWO first-class backends —
 *
 *   'wm'  (VT2): every tap emits the same plain {kind:'key', down, code,
 *         key, repeat, mods} record os.html's physical-keyboard listeners
 *         ship, so at the routeInput seam a synthetic key is BIT-IDENTICAL
 *         to a real one (compositor.js re-shapes it, host.js SCANCODE_MAP/
 *         keysym()/keymod() derive the SDL event — no new translation).
 *   'tty' (VT1): every tap emits tty BYTES through the page's vt1Input
 *         funnel (escape sequences per the xterm conventions term.c also
 *         speaks; sticky mods become control folds / ESC prefixes / the
 *         xterm CSI 1;N modifier encodings).
 *
 * Per-legend key tables, NOT runtime transforms: SDL3 keysyms are
 * modifier-applied (Shift+1 => '!'), and user32's vk_of reads the SCANCODE
 * for shifted digit-row symbols — so a '!' legend must carry the REAL pair
 * {code:'Digit1', key:'!'} plus a baked Shift mod. Every legend below is a
 * complete {c: DOM code, k: DOM key} entry (letters add K, the key while
 * Shift is armed); nothing derives a shifted character at press time.
 *
 * Sticky modifiers (the one real design constraint): wm.c tracks Ctrl/Shift
 * from REAL modifier keydown/keyup events, not per-event mod words — so
 * arming a mod sends a genuine modifier KEYDOWN, every subsequent event
 * merges it into its mods, and disarming sends the KEYUP. One-shot mods
 * disarm at the next regular key's KEYUP, never at its keydown: the kernel
 * swallows a chord's keyup only while the mod bits are still held
 * (kernel.js wmKey), so disarming at keydown would leak half a chord into
 * the focused app. Tap once = armed (one-shot), tap again = locked, tap a
 * third time = off. Multi-arm composes (Ctrl+Shift+C is term's copy chord).
 *
 * Key repeat is the OSK's own timer (~400ms delay then ~30Hz), resending
 * keydown with repeat:true — the plumbing honors it and kernel chords keep
 * cycling. Modifier and layer keys NEVER repeat.
 *
 * This file is page-side JS only (loaded by os.html next to the panes) —
 * zero kernel/C/image change. The component is DOM-owning but backend-
 * agnostic: os.html injects the two senders and the mode switch.
 */
'use strict';

var OSK = (function () {

  /* ---- per-legend tables ------------------------------------------- */

  function letter(ch) {
    return { l: ch, c: 'Key' + ch.toUpperCase(), k: ch, K: ch.toUpperCase() };
  }
  function digit(d) { return { l: d, c: 'Digit' + d, k: d }; }
  /* A plain (unshifted) punctuation legend. */
  function punct(label, code) { return { l: label, c: code, k: label }; }
  /* A SHIFTED symbol legend: the produced character plus the physical pair
     that makes it, with the Shift mod baked into the emitted event (the
     modifier-applied keysym + scancode a real Shift+code press carries). */
  function shifted(label, code) {
    return { l: label, c: code, k: label, m: { Shift: true } };
  }
  function fkey(n) { return { l: 'F' + n, c: 'F' + n, k: 'F' + n }; }

  var ESC   = { l: 'Esc', id: 'Escape', c: 'Escape', k: 'Escape', w: 1.4 };
  var TAB   = { l: 'Tab', id: 'Tab', c: 'Tab', k: 'Tab', w: 1.4 };
  var BKSP  = { l: '⌫', id: 'Backspace', c: 'Backspace', k: 'Backspace', w: 1.4 };
  var ENTER = { l: '⏎', id: 'Enter', c: 'Enter', k: 'Enter', w: 1.6 };
  var SPACE = { l: '', id: 'Space', c: 'Space', k: ' ', w: 3 };
  var UP    = { l: '↑', id: 'Up', c: 'ArrowUp', k: 'ArrowUp' };
  var DOWN  = { l: '↓', id: 'Down', c: 'ArrowDown', k: 'ArrowDown' };
  var LEFT  = { l: '←', id: 'Left', c: 'ArrowLeft', k: 'ArrowLeft' };
  var RIGHT = { l: '→', id: 'Right', c: 'ArrowRight', k: 'ArrowRight' };
  var INS   = { l: 'Ins', id: 'Insert', c: 'Insert', k: 'Insert' };
  var DEL   = { l: 'Del', id: 'Delete', c: 'Delete', k: 'Delete' };
  var HOME  = { l: 'Home', id: 'Home', c: 'Home', k: 'Home' };
  var END   = { l: 'End', id: 'End', c: 'End', k: 'End' };
  var PGUP  = { l: 'PgUp', id: 'PageUp', c: 'PageUp', k: 'PageUp' };
  var PGDN  = { l: 'PgDn', id: 'PageDown', c: 'PageDown', k: 'PageDown' };

  /* Sticky-modifier legends: no c/k here — the real key pair each arm/disarm
     synthesizes lives in MODKEYS (left variants, so wm.c sees SDLK_LCTRL). */
  var SHIFT = { l: '⇧', id: 'Shift', mod: 'Shift', w: 1.4 };
  var CTRL  = { l: 'Ctrl', id: 'Ctrl', mod: 'Control', w: 1.2 };
  var ALT   = { l: 'Alt', id: 'Alt', mod: 'Alt', w: 1.1 };
  var GUI   = { l: '⊞', id: 'Gui', mod: 'Meta' };
  var MODKEYS = {
    Control: { c: 'ControlLeft', k: 'Control' },
    Alt:     { c: 'AltLeft',     k: 'Alt' },
    Shift:   { c: 'ShiftLeft',   k: 'Shift' },
    Meta:    { c: 'MetaLeft',    k: 'Meta' },
  };

  var LSYM = { l: '?123', id: '?123', layer: 'sym', w: 1.3 };
  var LABC = { l: 'abc', id: 'abc', layer: 'abc', w: 1.3 };
  var LNUM = { l: 'Fn', id: 'Fn', layer: 'num' };

  /* Three layers; the bottom row is uniform (mods + Space + arrows) except
     for which layer keys it offers. Duplicated legends across layers are
     shared objects on purpose — legends are read-only data. */
  var LAYERS = {
    abc: [
      [ESC, letter('q'), letter('w'), letter('e'), letter('r'), letter('t'),
       letter('y'), letter('u'), letter('i'), letter('o'), letter('p'), BKSP],
      [TAB, letter('a'), letter('s'), letter('d'), letter('f'), letter('g'),
       letter('h'), letter('j'), letter('k'), letter('l'), ENTER],
      [SHIFT, letter('z'), letter('x'), letter('c'), letter('v'), letter('b'),
       letter('n'), letter('m'), punct(',', 'Comma'), punct('.', 'Period'), UP],
      [CTRL, ALT, GUI, LSYM, SPACE, punct('/', 'Slash'), LNUM, LEFT, DOWN, RIGHT],
    ],
    sym: [
      [ESC, digit('1'), digit('2'), digit('3'), digit('4'), digit('5'),
       digit('6'), digit('7'), digit('8'), digit('9'), digit('0'), BKSP],
      [TAB, shifted('!', 'Digit1'), shifted('@', 'Digit2'), shifted('#', 'Digit3'),
       shifted('$', 'Digit4'), shifted('%', 'Digit5'), shifted('^', 'Digit6'),
       shifted('&', 'Digit7'), shifted('*', 'Digit8'), shifted('(', 'Digit9'),
       shifted(')', 'Digit0'), ENTER],
      [SHIFT, punct('-', 'Minus'), shifted('_', 'Minus'), shifted('+', 'Equal'),
       punct('=', 'Equal'), punct(';', 'Semicolon'), shifted(':', 'Semicolon'),
       punct("'", 'Quote'), shifted('"', 'Quote'), shifted('?', 'Slash'), UP],
      [CTRL, ALT, GUI, LABC, SPACE, punct(',', 'Comma'), LNUM, LEFT, DOWN, RIGHT],
    ],
    num: [
      [ESC, fkey(1), fkey(2), fkey(3), fkey(4), fkey(5), fkey(6), fkey(7),
       fkey(8), fkey(9), fkey(10), BKSP],
      [TAB, fkey(11), fkey(12), INS, DEL, HOME, END, PGUP, PGDN, ENTER],
      [SHIFT, punct('`', 'Backquote'), shifted('~', 'Backquote'),
       punct('[', 'BracketLeft'), punct(']', 'BracketRight'),
       shifted('{', 'BracketLeft'), shifted('}', 'BracketRight'),
       punct('\\', 'Backslash'), shifted('|', 'Backslash'),
       shifted('<', 'Comma'), shifted('>', 'Period'), UP],
      [CTRL, ALT, GUI, LABC, SPACE, LSYM, LEFT, DOWN, RIGHT],
    ],
  };

  /* ---- VT1 (tty-byte) encodings ------------------------------------ */
  /* Named-key escape sequences, keyed by DOM key. The base forms match the
     estate's conventions (the 0212 keystrip arrows, term.c's own replies);
     with sticky mods armed they take the xterm modifier encodings:
     CSI 1;N A-D for cursor keys, CSI n;N ~ for the tilde group, CSI 1;N P-S
     for the SS3 F1-F4, where N = 1 + Shift(1) + Alt(2) + Ctrl(4) + Meta(8). */
  var VT1_SEQ = {
    ArrowUp: { csi: 'A' }, ArrowDown: { csi: 'B' },
    ArrowRight: { csi: 'C' }, ArrowLeft: { csi: 'D' },
    Home: { tilde: 1 }, Insert: { tilde: 2 }, Delete: { tilde: 3 },
    End: { tilde: 4 }, PageUp: { tilde: 5 }, PageDown: { tilde: 6 },
    F1: { ss3: 'P' }, F2: { ss3: 'Q' }, F3: { ss3: 'R' }, F4: { ss3: 'S' },
    F5: { tilde: 15 }, F6: { tilde: 17 }, F7: { tilde: 18 }, F8: { tilde: 19 },
    F9: { tilde: 20 }, F10: { tilde: 21 }, F11: { tilde: 23 }, F12: { tilde: 24 },
  };

  function vt1Bytes(leg, st) {
    var k = (st.Shift && leg.K) ? leg.K : leg.k;
    var sh = st.Shift || !!(leg.m && leg.m.Shift);
    var mc = 1 + (sh ? 1 : 0) + (st.Alt ? 2 : 0) + (st.Control ? 4 : 0) + (st.Meta ? 8 : 0);
    var q = VT1_SEQ[k];
    if (q) {
      if (mc > 1) {
        if (q.csi) return '\x1b[1;' + mc + q.csi;
        if (q.ss3) return '\x1b[1;' + mc + q.ss3;
        return '\x1b[' + q.tilde + ';' + mc + '~';
      }
      if (q.csi) return '\x1b[' + q.csi;
      if (q.ss3) return '\x1bO' + q.ss3;
      return '\x1b[' + q.tilde + '~';
    }
    if (k === 'Escape') return '\x1b';
    if (k === 'Enter') return st.Alt ? '\x1b\r' : '\r';
    if (k === 'Backspace') return st.Alt ? '\x1b\x7f' : '\x7f';
    if (k === 'Tab') return sh ? '\x1b[Z' : (st.Alt ? '\x1b\t' : '\t');
    if (k.length !== 1) return '';
    if (st.Control) {
      /* The tty control fold (term.c's rule): uppercase, then ^@..^_ for
         '@'..'_', NUL for space; unfoldable chars pass through plain. */
      if (k === ' ') return '\x00';
      var c = k.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) return String.fromCharCode(c & 0x1f);
      return k;
    }
    return st.Alt ? '\x1b' + k : k;   /* Alt = the readline ESC prefix */
  }

  /* ---- the component ------------------------------------------------ */

  var REPEAT_DELAY_MS = 400, REPEAT_HZ = 30;

  function create(opts) {
    var container = opts.container;
    var mode = opts.mode;                   /* () => 'wm' | 'tty' */
    var sendWm = opts.sendWmKey;            /* (plain key record) => void */
    var sendTty = opts.sendTtyBytes;        /* (string) => void */
    var onChange = opts.onChange || function () {};

    var layer = 'abc';
    var open = false;
    /* Per-mod sticky state: 0 off, 1 armed (one-shot), 2 locked. */
    var mods = { Control: 0, Alt: 0, Shift: 0, Meta: 0 };
    var presses = {};                       /* pointerId -> live press */
    var sent = [];                          /* injection log (agent probe) */
    var sentSeq = 0;                        /* monotonic — survives the cap */

    function log(be, what) {
      sent.push({ seq: ++sentSeq, be: be, ev: what });
      if (sent.length > 64) sent.shift();
    }
    function armedSt() {
      return { Shift: mods.Shift > 0, Control: mods.Control > 0,
               Alt: mods.Alt > 0, Meta: mods.Meta > 0 };
    }
    function modMap(extra) {
      var st = armedSt();
      var m = { Shift: st.Shift, Control: st.Control, Alt: st.Alt, Meta: st.Meta };
      if (extra) for (var p in extra) if (extra[p]) m[p] = true;
      return m;
    }
    function injectWm(down, code, key, extra, repeat) {
      var ev = { kind: 'key', down: !!down, code: code, key: key,
                 repeat: !!repeat, mods: modMap(extra) };
      log('wm', ev);
      sendWm(ev);
    }
    function state() {
      var m = {};
      for (var n in mods) m[n] = mods[n] === 2 ? 'locked' : mods[n] === 1 ? 'armed' : 'off';
      return { open: open, layer: layer, mods: m };
    }
    function changed() { onChange(state()); }

    /* Sticky-mod transitions. The mod's own key event is built AFTER the
       state flip, so a keydown reports itself held and a keyup doesn't —
       matching DOM getModifierState semantics for real modifier events.
       Arm/disarm events only exist on the wm backend; VT1 mods are pure
       transforms (a tty has no key state). */
    function setMod(name, val) {
      var was = mods[name];
      if (was === val) return;
      mods[name] = val;
      if (mode() === 'wm') {
        if (was === 0 && val > 0) injectWm(true, MODKEYS[name].c, MODKEYS[name].k);
        else if (val === 0) injectWm(false, MODKEYS[name].c, MODKEYS[name].k);
      }
      render();
      changed();
    }
    function modTap(name) {
      setMod(name, mods[name] === 0 ? 1 : mods[name] === 1 ? 2 : 0);
    }
    /* One-shot consumption point: AFTER a regular key's release (see the
       header — disarming at keydown would leak half a kernel chord). */
    function consumeOneShots() {
      for (var n in mods) if (mods[n] === 1) setMod(n, 0);
    }

    function keyDown(leg, repeat) {
      if (mode() === 'wm') {
        var key = (mods.Shift > 0 && leg.K) ? leg.K : leg.k;
        injectWm(true, leg.c, key, leg.m, repeat);
      } else {
        var b = vt1Bytes(leg, armedSt());
        if (b) { log('tty', b); sendTty(b); }
      }
    }
    function keyUp(leg) {
      if (mode() === 'wm') {
        /* Same shifted key as the down (one-shots are still armed here). */
        var key = (mods.Shift > 0 && leg.K) ? leg.K : leg.k;
        injectWm(false, leg.c, key, leg.m);
      }
      consumeOneShots();
    }

    function pressStart(leg, pid) {
      if (presses[pid]) pressEnd(pid);   /* stale same-pointer press */
      if (leg.mod) { modTap(leg.mod); return; }        /* never repeats */
      if (leg.layer) { layer = leg.layer; render(); changed(); return; }
      keyDown(leg, false);
      var p = { leg: leg };
      p.delayT = setTimeout(function () {
        p.intT = setInterval(function () { keyDown(leg, true); },
                             Math.round(1000 / REPEAT_HZ));
      }, REPEAT_DELAY_MS);
      presses[pid] = p;
    }
    function pressEnd(pid) {
      var p = presses[pid];
      if (!p) return;
      delete presses[pid];
      clearTimeout(p.delayT);
      if (p.intT) clearInterval(p.intT);
      keyUp(p.leg);
    }
    function releaseAll() { for (var pid in presses) pressEnd(pid); }
    function disarmAll() { for (var n in mods) if (mods[n]) setMod(n, 0); }

    function render() {
      container.textContent = '';
      var inner = document.createElement('div');
      inner.className = 'oskin';
      LAYERS[layer].forEach(function (row) {
        var r = document.createElement('div');
        r.className = 'oskrow';
        row.forEach(function (leg) {
          var b = document.createElement('div');
          var cls = 'oskkey';
          if (leg.mod) {
            if (mods[leg.mod] === 1) cls += ' armed';
            else if (mods[leg.mod] === 2) cls += ' locked';
          }
          b.className = cls;
          b.textContent = (mods.Shift > 0 && leg.K) ? leg.K : leg.l;
          b.setAttribute('data-k', leg.id || leg.l);
          if (leg.w) b.style.flexGrow = leg.w;
          /* pointerdown (keystrip precedent): preventDefault keeps the
             active pane focused — xterm's textarea on VT1, the canvas on
             VT2 — so injection composes with whatever focus already holds. */
          b.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            pressStart(leg, e.pointerId === undefined ? 'mouse' : e.pointerId);
          });
          r.appendChild(b);
        });
        inner.appendChild(r);
      });
      container.appendChild(inner);
    }
    /* Releases live on the WINDOW: a mod-tap rerender replaces the pressed
       key's element mid-hold, so a button-local pointerup could go missing
       and leave the repeat timer running. The press map is keyed by
       pointerId, not by node, so the window listener always finds it. */
    window.addEventListener('pointerup', function (e) {
      pressEnd(e.pointerId === undefined ? 'mouse' : e.pointerId);
    });
    window.addEventListener('pointercancel', function (e) {
      pressEnd(e.pointerId === undefined ? 'mouse' : e.pointerId);
    });

    function findLeg(id) {
      var rows = LAYERS[layer];
      for (var i = 0; i < rows.length; i++)
        for (var j = 0; j < rows[i].length; j++)
          if ((rows[i][j].id || rows[i][j].l) === id) return rows[i][j];
      throw new Error('OSK: no key "' + id + '" on layer ' + layer);
    }

    render();
    changed();

    return {
      isOpen: function () { return open; },
      setOpen: function (on) {
        on = !!on;
        if (on === open) return;
        open = on;
        if (!on) { releaseAll(); disarmAll(); }   /* nothing sticks shut */
        changed();
      },
      /* Called by the page BEFORE a VT switch: release held keys and disarm
         every sticky mod through the OUTGOING backend (the keyups must land
         where the arm keydowns did). */
      vtWillChange: function () { releaseAll(); disarmAll(); },
      state: state,
      /* Test/agent drivers, addressed by data-k id on the CURRENT layer. */
      tap: function (id) { var l = findLeg(id); pressStart(l, 'probe'); pressEnd('probe'); },
      down: function (id) { pressStart(findLeg(id), 'probe'); },
      up: function () { pressEnd('probe'); },
      sentLog: function () { return sent.slice(); },
    };
  }

  return { create: create, vt1Bytes: vt1Bytes, LAYERS: LAYERS };
})();
