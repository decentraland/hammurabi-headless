/**
 * The viewer client, embedded as a constant.
 *
 * Embedded rather than shipped as an asset file because `tsc` only emits .js —
 * a separate .html would need a build step to reach dist/ and would silently
 * 404 for anyone installing the npm package. Babylon is pulled from the CDN
 * instead of bundled so enabling a debug tool never changes what the published
 * package weighs or what esbuild has to resolve.
 *
 * The page JS deliberately avoids template literals so this outer literal needs
 * no escaping.
 */
export const VIEWER_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>hammurabi · server view</title>
<script src="https://cdn.babylonjs.com/babylon.js"></script>
<script src="https://cdn.babylonjs.com/loaders/babylonjs.loaders.min.js"></script>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #1f1d23; color: #e8e6ef;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  #c { width: 100vw; height: 100vh; display: block; touch-action: none; outline: none; }
  #hud { position: fixed; top: 12px; left: 12px; padding: 10px 12px; border-radius: 8px;
    background: rgba(20,19,24,.82); border: 1px solid rgba(255,255,255,.12); max-width: 320px;
    backdrop-filter: blur(6px); }
  #hud h1 { margin: 0 0 6px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; opacity: .6; }
  .row { display: flex; justify-content: space-between; gap: 12px; }
  .row span:last-child { opacity: .85; }
  .warn { color: #ffb454; }
  .bad { color: #ff6b6b; }
  .ok { color: #7ee787; }
  #modes { display: flex; gap: 4px; margin: 8px 0 4px; }
  button { flex: 1; padding: 4px 6px; border-radius: 5px; cursor: pointer; font: inherit;
    background: rgba(255,255,255,.07); color: inherit; border: 1px solid rgba(255,255,255,.14); }
  button.active { background: #4a3f7a; border-color: #7a68c4; }
  label { display: block; opacity: .8; }
  #peers { margin-top: 6px; max-height: 180px; overflow: auto; }
  #peers .peer { display: flex; justify-content: space-between; gap: 8px; cursor: pointer;
    padding: 2px 5px; border-radius: 4px; border: 1px solid transparent; }
  #peers .peer:hover { background: rgba(255,255,255,.09); }
  #peers .peer.sel { background: #3d3560; border-color: #7a68c4; }
  #peers .peer .tag { opacity: .5; }
  #peers .empty { opacity: .45; padding: 2px 5px; }
  #help { margin-top: 8px; opacity: .5; line-height: 1.45; }
  kbd { background: rgba(255,255,255,.11); border-radius: 3px; padding: 0 3px; }
  hr { border: 0; border-top: 1px solid rgba(255,255,255,.12); margin: 8px 0; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="hud">
  <h1>server view</h1>
  <div class="row"><span>link</span><span id="status" class="warn">connecting…</span></div>
  <div class="row"><span>scene</span><span id="scene">–</span></div>
  <div class="row"><span>entities</span><span id="count">0</span></div>
  <div class="row"><span>snapshot age</span><span id="age">–</span></div>
  <div class="row"><span>viewer fps</span><span id="fps">0</span></div>
  <div class="row"><span>camera</span><span id="campos">–</span></div>
  <div id="modes">
    <button id="m-fly" class="active">fly</button>
    <button id="m-orbit">orbit</button>
    <button id="m-follow">follow</button>
    <button id="m-eyes">eyes</button>
  </div>
  <label><input type="checkbox" id="t-empties" /> show empty entities</label>
  <label><input type="checkbox" id="t-colliders" /> show colliders</label>
  <hr />
  <div class="row"><span>go to <span class="tag" style="opacity:.5">(click)</span></span><span id="peercount">0 peers</span></div>
  <div id="peers"></div>
  <div id="help">
    <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>E</kbd>/<kbd>Q</kbd> up/down ·
    drag to look · <kbd>shift</kbd> ×5 · <kbd>ctrl</kbd> ×¼<br />
    <kbd>F</kbd> server player · <kbd>N</kbd> next peer · <kbd>G</kbd> go to selected
  </div>
</div>
<script>
(function () {
  'use strict'

  // Kept in sync with the host: CharacterController builds the capsule with
  // height 1.7 / radius 0.4, and the transforms on the wire are FEET-anchored
  // (PLAYER_CAPSULE_HALF_HEIGHT) — drawing them at face value would sink every
  // avatar half a body into the ground.
  var PLAYER_HEIGHT = 1.7
  var PLAYER_RADIUS = 0.4
  var HALF_HEIGHT = PLAYER_HEIGHT / 2
  var PARCEL = 16
  var LERP = 0.35

  var canvas = document.getElementById('c')
  var engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false })
  var scene = new BABYLON.Scene(engine)
  scene.clearColor = new BABYLON.Color4(0.12, 0.11, 0.14, 1)

  var BASE_SPEED = 12 // metres/second at 1x

  // Free-flight camera, the default: a scene can span thousands of parcels, so
  // orbiting a fixed target is close to useless for getting somewhere.
  var fly = new BABYLON.UniversalCamera('fly', new BABYLON.Vector3(0, 12, -24), scene)
  fly.minZ = 0.05
  fly.speed = 0 // movement is integrated manually below, frame-rate independent
  fly.inertia = 0.6
  fly.angularSensibility = 1400
  // Babylon's own keyboard input listens through the canvas focus chain, so a
  // click on the HUD silently kills WASD. Movement is driven from a window-level
  // key map instead; the built-in mouse-look input stays.
  fly.inputs.removeByType('FreeCameraKeyboardMoveInput')
  fly.attachControl(canvas, true)

  var orbit = new BABYLON.ArcRotateCamera('orbit', -Math.PI / 2, Math.PI / 3.2, 34, BABYLON.Vector3.Zero(), scene)
  orbit.wheelPrecision = 12
  orbit.lowerRadiusLimit = 1
  orbit.panningSensibility = 250 // right-drag pans the target

  var eyes = new BABYLON.FreeCamera('eyes', new BABYLON.Vector3(0, 2, 0), scene)
  eyes.minZ = 0.05

  scene.activeCamera = fly

  var hemi = new BABYLON.HemisphericLight('h', new BABYLON.Vector3(0.3, 1, 0.2), scene)
  hemi.intensity = 0.9
  hemi.groundColor = new BABYLON.Color3(0.22, 0.2, 0.28)
  var sun = new BABYLON.DirectionalLight('s', new BABYLON.Vector3(-0.5, -1, -0.3), scene)
  sun.intensity = 0.6

  function mat(name, r, g, b, alpha, wire) {
    var m = new BABYLON.StandardMaterial(name, scene)
    m.diffuseColor = new BABYLON.Color3(r, g, b)
    m.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05)
    m.emissiveColor = new BABYLON.Color3(r * 0.25, g * 0.25, b * 0.25)
    if (alpha < 1) { m.alpha = alpha }
    if (wire) { m.wireframe = true }
    return m
  }
  var MATS = {
    player: mat('m-player', 0.36, 0.86, 0.45, 1, false),
    avatar: mat('m-avatar', 0.36, 0.7, 0.95, 1, false),
    mesh: mat('m-mesh', 0.75, 0.72, 0.82, 1, false),
    ghost: mat('m-ghost', 0.95, 0.6, 0.25, 1, true),
    pending: mat('m-pending', 0.5, 0.45, 0.6, 1, true),
    failed: mat('m-failed', 0.9, 0.3, 0.3, 1, true),
    collider: mat('m-collider', 0.35, 0.9, 0.85, 1, true),
    parcel: mat('m-parcel', 0.45, 0.4, 0.6, 1, true),
    empty: mat('m-empty', 0.6, 0.55, 0.7, 0.5, true),
    ground: mat('m-ground', 0.17, 0.16, 0.21, 1, false)
  }

  var el = {
    status: document.getElementById('status'),
    scene: document.getElementById('scene'),
    count: document.getElementById('count'),
    age: document.getElementById('age'),
    fps: document.getElementById('fps'),
    peers: document.getElementById('peers'),
    peercount: document.getElementById('peercount'),
    campos: document.getElementById('campos'),
    empties: document.getElementById('t-empties'),
    colliders: document.getElementById('t-colliders')
  }

  var mode = 'fly'
  var MODE_BUTTONS = { fly: 'm-fly', orbit: 'm-orbit', follow: 'm-follow', eyes: 'm-eyes' }

  function setMode(next) {
    mode = next
    for (var key in MODE_BUTTONS) {
      document.getElementById(MODE_BUTTONS[key]).className = key === next ? 'active' : ''
    }
    // Exactly one camera holds the pointer input at a time, or drag-look and
    // orbit-drag fight over the same gesture.
    fly.detachControl()
    orbit.detachControl()
    if (next === 'fly') {
      scene.activeCamera = fly
      fly.attachControl(canvas, true)
    } else if (next === 'eyes') {
      scene.activeCamera = eyes
    } else {
      scene.activeCamera = orbit
      orbit.attachControl(canvas, true)
    }
    canvas.focus()
  }
  for (var modeKey in MODE_BUTTONS) {
    (function (m) {
      document.getElementById(MODE_BUTTONS[m]).onclick = function () { setMode(m) }
    })(modeKey)
  }

  // ------------------------------------------------------------------- input

  // Window-level so the keys keep working after interacting with the HUD, and
  // so movement can be integrated against real elapsed time rather than
  // Babylon's per-keystroke step (which is frame-rate dependent).
  var keys = Object.create(null)
  var MOVE_CODES = {
    KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1, KeyQ: 1, KeyE: 1,
    ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Space: 1
  }

  window.addEventListener('keydown', function (ev) {
    var tag = ev.target && ev.target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') { return }
    keys[ev.code] = true
    // Space/arrows would otherwise scroll the page or toggle a focused control.
    if (MOVE_CODES[ev.code]) { ev.preventDefault() }
    if (ev.code === 'KeyF') { selectPlayer(); goToSelected() }
    if (ev.code === 'KeyN') { cyclePeer() }
    if (ev.code === 'KeyG') { goToSelected() }
  })
  window.addEventListener('keyup', function (ev) { keys[ev.code] = false })
  // A dropped keyup (tab switch, window blur) would leave a key stuck down.
  window.addEventListener('blur', function () { keys = Object.create(null) })
  canvas.tabIndex = 0
  canvas.focus()

  // ---------------------------------------------------------------- entities

  // key -> { node, kind, target:{p,q,s}, gltf, collider }
  var nodes = Object.create(null)
  var gltfCache = Object.create(null)
  var groundBuilt = Object.create(null)
  var playerState = null

  function makeBody(kind, entry, data) {
    if (kind === 'player' || kind === 'avatar') {
      var capsule = BABYLON.MeshBuilder.CreateCapsule('body', { height: PLAYER_HEIGHT, radius: PLAYER_RADIUS }, scene)
      capsule.material = kind === 'player' ? MATS.player : MATS.avatar
      // Lift by half the height: the wire transform is the feet, a capsule's
      // origin is its centre.
      capsule.position.y = HALF_HEIGHT
      return capsule
    }
    if (kind === 'box') { return BABYLON.MeshBuilder.CreateBox('body', { size: 1 }, scene) }
    if (kind === 'sphere') { return BABYLON.MeshBuilder.CreateSphere('body', { diameter: 1 }, scene) }
    if (kind === 'plane') { return BABYLON.MeshBuilder.CreatePlane('body', { size: 1, sideOrientation: 2 }, scene) }
    if (kind === 'cylinder') { return BABYLON.MeshBuilder.CreateCylinder('body', { height: 1, diameter: 1 }, scene) }
    if (kind === 'gltf') { return loadGltf(entry, data) }
    // root / camera / node: a small marker, hidden unless "show empties"
    var marker = BABYLON.MeshBuilder.CreateBox('empty', { size: 0.25 }, scene)
    marker.material = MATS.empty
    marker.isVisible = el.empties.checked
    return marker
  }

  function loadGltf(entry, data) {
    // Placeholder until the real asset arrives, so an entity the server has but
    // the browser is still fetching is visibly distinct from one that failed.
    var placeholder = BABYLON.MeshBuilder.CreateBox('gltf-pending', { size: 1 }, scene)
    placeholder.material = MATS.pending
    if (!data.src) { placeholder.material = MATS.failed; return placeholder }

    var container = gltfCache[data.src]
    if (!container) {
      // The URL comes from the scene's own content mapping, resolved host-side.
      // Content hashes carry no extension, so the loader needs it stated.
      container = BABYLON.SceneLoader.LoadAssetContainerAsync(data.src, '', scene, null, '.glb')
      gltfCache[data.src] = container
    }
    container.then(function (assets) {
      if (entry.disposed) { return }
      var instance = assets.instantiateModelsToScene(function (n) { return n }, false)
      var roots = instance.rootNodes
      for (var i = 0; i < roots.length; i++) { roots[i].parent = entry.node }
      entry.instance = instance
      placeholder.dispose()
    }).catch(function () {
      // Most often a .gltf with external dependencies (their URLs are content
      // hashes the browser cannot resolve by filename) or a CORS refusal.
      if (!entry.disposed) { placeholder.material = MATS.failed }
    })
    return placeholder
  }

  function makeCollider(shape) {
    var mesh = null
    if (shape === 'box') { mesh = BABYLON.MeshBuilder.CreateBox('col', { size: 1 }, scene) }
    else if (shape === 'sphere') { mesh = BABYLON.MeshBuilder.CreateSphere('col', { diameter: 1 }, scene) }
    else if (shape === 'plane') { mesh = BABYLON.MeshBuilder.CreatePlane('col', { size: 1, sideOrientation: 2 }, scene) }
    else if (shape === 'cylinder') { mesh = BABYLON.MeshBuilder.CreateCylinder('col', { height: 1, diameter: 1 }, scene) }
    if (mesh) { mesh.material = MATS.collider }
    return mesh
  }

  function ensure(key, data) {
    var entry = nodes[key]
    if (entry && entry.kind === data.k) { return entry }
    if (entry) { destroy(key) }

    entry = { kind: data.k, disposed: false, node: new BABYLON.TransformNode('e' + key, scene) }
    entry.node.rotationQuaternion = BABYLON.Quaternion.Identity()
    var body = makeBody(data.k, entry, data)
    if (body) {
      body.parent = entry.node
      if (data.k !== 'player' && data.k !== 'avatar' && data.k !== 'gltf' && !body.material) {
        body.material = data.ghost ? MATS.ghost : MATS.mesh
      }
      if (data.ghost && body.material === MATS.mesh) { body.material = MATS.ghost }
      entry.body = body
    }
    // Seed the transform on creation: the render loop eases toward the target,
    // so without this every newly spawned entity would visibly fly in from the
    // world origin.
    entry.node.position.set(data.p[0], data.p[1], data.p[2])
    entry.node.rotationQuaternion.set(data.q[0], data.q[1], data.q[2], data.q[3])
    entry.node.scaling.set(data.s[0], data.s[1], data.s[2])
    nodes[key] = entry
    return entry
  }

  function destroy(key) {
    var entry = nodes[key]
    if (!entry) { return }
    entry.disposed = true
    if (entry.instance) { entry.instance.dispose() }
    entry.node.dispose(false, true)
    delete nodes[key]
  }

  // Above this, per-parcel tiles stop being useful and start being the viewer's
  // whole frame budget: a World can declare thousands of parcels (2 meshes each),
  // so past the threshold the footprint is drawn as one ground over its bounds.
  var MAX_PARCEL_TILES = 256

  function buildGround(sceneInfo) {
    if (groundBuilt[sceneInfo.id]) { return }
    groundBuilt[sceneInfo.id] = true

    var raw = sceneInfo.parcels || (sceneInfo.base ? [sceneInfo.base] : [])
    var coords = []
    var minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (var i = 0; i < raw.length; i++) {
      var parts = String(raw[i]).split(',')
      var px = parseInt(parts[0], 10)
      var pz = parseInt(parts[1], 10)
      if (isNaN(px) || isNaN(pz)) { continue }
      coords.push([px, pz])
      if (px < minX) { minX = px }
      if (pz < minZ) { minZ = pz }
      if (px > maxX) { maxX = px }
      if (pz > maxZ) { maxZ = pz }
    }
    if (!coords.length) { return }

    if (coords.length > MAX_PARCEL_TILES) {
      var w = (maxX - minX + 1) * PARCEL
      var d = (maxZ - minZ + 1) * PARCEL
      var slab = BABYLON.MeshBuilder.CreateGround('bounds', { width: w, height: d }, scene)
      slab.position.set(minX * PARCEL + w / 2, 0, minZ * PARCEL + d / 2)
      slab.material = MATS.ground
      slab.isPickable = false
      return
    }

    for (var j = 0; j < coords.length; j++) {
      var tile = BABYLON.MeshBuilder.CreateGround('p', { width: PARCEL, height: PARCEL }, scene)
      // Parcel (x,y) spans world [x*16,(x+1)*16] — the same mapping gridToWorld
      // uses host-side — so the tile centre sits half a parcel in.
      tile.position.set(coords[j][0] * PARCEL + PARCEL / 2, 0, coords[j][1] * PARCEL + PARCEL / 2)
      tile.material = MATS.ground
      tile.isPickable = false
      var outline = BABYLON.MeshBuilder.CreateGround('po', { width: PARCEL, height: PARCEL }, scene)
      outline.position.copyFrom(tile.position)
      outline.position.y = 0.01
      outline.material = MATS.parcel
      outline.isPickable = false
    }
  }

  // -------------------------------------------------------------- navigation

  // The selection drives follow/eyes and the go-to keys, so "watch this peer"
  // is one click rather than a camera-mode-specific gesture.
  var selectedKey = null
  var playerKey = null
  var peerKeys = []

  function stateOf(key) {
    var entry = key && nodes[key]
    return entry ? entry.target : null
  }

  function select(key) {
    selectedKey = key
    renderPeerList()
  }

  function selectPlayer() {
    if (playerKey) { select(playerKey) }
  }

  function cyclePeer() {
    if (!peerKeys.length) { return }
    var at = peerKeys.indexOf(selectedKey)
    select(peerKeys[(at + 1) % peerKeys.length])
    goToSelected()
  }

  /**
   * Put the fly camera over the selection's shoulder and look at its head.
   * Placed BEHIND it using its own facing, so a peer you jump to is framed the
   * way they are looking rather than from an arbitrary angle.
   */
  function goToSelected() {
    var state = stateOf(selectedKey)
    if (!state) { return }
    var head = new BABYLON.Vector3(state.p[0], state.p[1] + PLAYER_HEIGHT * 0.9, state.p[2])
    var facing = new BABYLON.Vector3(0, 0, 1)
    var q = new BABYLON.Quaternion(state.q[0], state.q[1], state.q[2], state.q[3])
    facing.rotateByQuaternionToRef(q, facing)
    facing.y = 0
    if (facing.lengthSquared() < 0.001) { facing.set(0, 0, 1) }
    facing.normalize()

    fly.position.copyFrom(head.subtract(facing.scale(4.5)).add(new BABYLON.Vector3(0, 1.4, 0)))
    fly.setTarget(head)
    if (mode !== 'follow' && mode !== 'eyes') { setMode('fly') }
    if (mode === 'follow') { orbit.target.copyFrom(head) }
  }

  // Rebuilding this list every snapshot (15Hz) would replace the row under the
  // cursor between mousedown and mouseup, so clicks would never land. The DOM is
  // rebuilt only when the roster or selection actually changes; the live
  // coordinates are written into the existing rows.
  var listSignature = null
  var rows = Object.create(null)

  function renderPeerList() {
    var signature = playerKey + '|' + peerKeys.join(',') + '|' + selectedKey
    if (signature !== listSignature) {
      listSignature = signature
      rows = Object.create(null)
      el.peers.innerHTML = ''
      var all = playerKey ? [playerKey].concat(peerKeys) : peerKeys.slice()
      if (!all.length) {
        el.peers.innerHTML = '<div class="empty">no peers connected</div>'
      }
      for (var i = 0; i < all.length; i++) {
        var key = all[i]
        var state = stateOf(key)
        var label = key === playerKey ? 'server player' : (state && state.n) || 'peer ' + key.split(':')[1]
        var row = document.createElement('div')
        row.className = 'peer' + (key === selectedKey ? ' sel' : '')
        row.setAttribute('data-key', key)
        var name = document.createElement('span')
        // textContent, never innerHTML: the label is a peer-supplied profile name.
        name.textContent = label
        var tag = document.createElement('span')
        tag.className = 'tag'
        row.appendChild(name)
        row.appendChild(tag)
        el.peers.appendChild(row)
        rows[key] = tag
      }
    }
    for (var k in rows) {
      var s = stateOf(k)
      rows[k].textContent = s ? fmtPos(s.p) : ''
    }
  }

  function fmtPos(p) {
    return Math.round(p[0]) + ',' + Math.round(p[2])
  }

  el.peers.addEventListener('click', function (ev) {
    var row = ev.target.closest ? ev.target.closest('.peer') : null
    if (!row) { return }
    select(row.getAttribute('data-key'))
    goToSelected()
  })

  // ------------------------------------------------------------------ socket

  var lastSnapshotAt = 0
  var lastServerTime = 0
  var framed = false

  function applySnapshot(snap) {
    lastSnapshotAt = performance.now()
    lastServerTime = snap.time
    var seen = Object.create(null)
    var total = 0
    var truncated = 0
    var peers = []

    for (var s = 0; s < snap.scenes.length; s++) {
      var sc = snap.scenes[s]
      buildGround(sc)
      if (s === 0) { el.scene.textContent = sc.base || sc.urn || sc.id }
      if (sc.truncated) { truncated += sc.truncated }

      for (var i = 0; i < sc.entities.length; i++) {
        var e = sc.entities[i]
        if (e.k === 'root' || e.k === 'camera') { continue }
        total++
        var key = sc.id + ':' + e.id
        seen[key] = true
        var entry = ensure(key, e)
        entry.target = e
        if (e.k === 'player') { playerState = e; playerKey = key }
        if (e.k === 'avatar') { peers.push(key) }

        if (el.colliders.checked && e.col && !entry.collider) {
          var col = makeCollider(e.col)
          if (col) { col.parent = entry.node; entry.collider = col }
        } else if (!el.colliders.checked && entry.collider) {
          entry.collider.dispose(); entry.collider = null
        }
        if (entry.body && (e.k === 'root' || e.k === 'camera' || e.k === 'node')) {
          entry.body.isVisible = el.empties.checked
        }
      }
    }

    for (var key2 in nodes) { if (!seen[key2]) { destroy(key2) } }

    peerKeys = peers
    if (selectedKey && !seen[selectedKey]) { selectedKey = null }
    if (!selectedKey) { selectedKey = playerKey }
    renderPeerList()

    // Fly straight to the server's player on the first snapshot that has one: a
    // multi-parcel scene's origin can be tens of parcels from where anything is
    // happening, which is why this opened "at a distance" before.
    if (!framed && playerState) {
      framed = true
      orbit.target.set(playerState.p[0], playerState.p[1] + HALF_HEIGHT, playerState.p[2])
      goToSelected()
    }

    el.count.textContent = truncated ? (total + ' (+' + truncated + ' truncated)') : String(total)
    el.count.className = truncated ? 'warn' : ''
    el.peercount.textContent = peers.length + (peers.length === 1 ? ' peer' : ' peers')
  }

  var ws = null
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host)
    ws.onopen = function () { el.status.textContent = 'live'; el.status.className = 'ok' }
    ws.onmessage = function (ev) {
      try { applySnapshot(JSON.parse(ev.data)) } catch (err) { /* ignore a bad frame */ }
    }
    ws.onclose = function () {
      el.status.textContent = 'reconnecting…'
      el.status.className = 'bad'
      setTimeout(connect, 1000)
    }
    ws.onerror = function () { try { ws.close() } catch (e) {} }
  }
  connect()

  // ------------------------------------------------------------------ render

  var tmpQ = new BABYLON.Quaternion()
  var tmpV = new BABYLON.Vector3()
  var moveDir = new BABYLON.Vector3()
  var fwd = new BABYLON.Vector3()
  var right = new BABYLON.Vector3()

  function axis(negCodes, posCodes) {
    var value = 0
    for (var i = 0; i < posCodes.length; i++) { if (keys[posCodes[i]]) { value += 1; break } }
    for (var j = 0; j < negCodes.length; j++) { if (keys[negCodes[j]]) { value -= 1; break } }
    return value
  }

  function moveCamera(dtSeconds) {
    var forwardAxis = axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp'])
    var strafeAxis = axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight'])
    var verticalAxis = axis(['KeyQ'], ['KeyE', 'Space'])
    if (!forwardAxis && !strafeAxis && !verticalAxis) { return }

    var speed = BASE_SPEED * dtSeconds
    if (keys.ShiftLeft || keys.ShiftRight) { speed *= 5 }
    if (keys.ControlLeft || keys.ControlRight) { speed *= 0.25 }

    if (mode === 'orbit' || mode === 'follow') {
      // Slide the orbit target itself — otherwise "moving" in orbit mode can
      // only ever circle whatever it was already pointed at.
      orbit.getDirectionToRef(BABYLON.Axis.Z, fwd)
      fwd.y = 0
      if (fwd.lengthSquared() > 0.0001) { fwd.normalize() }
      orbit.getDirectionToRef(BABYLON.Axis.X, right)
      right.y = 0
      if (right.lengthSquared() > 0.0001) { right.normalize() }
      moveDir.set(0, 0, 0)
      moveDir.addInPlace(fwd.scale(forwardAxis))
      moveDir.addInPlace(right.scale(strafeAxis))
      moveDir.y += verticalAxis
      orbit.target.addInPlace(moveDir.scale(speed))
      // Panning in follow mode would fight the tracking every frame.
      if (mode === 'follow') { setMode('orbit') }
      return
    }

    if (mode !== 'fly') { return }
    fly.getDirectionToRef(BABYLON.Axis.Z, fwd)
    fly.getDirectionToRef(BABYLON.Axis.X, right)
    moveDir.set(0, 0, 0)
    moveDir.addInPlace(fwd.scale(forwardAxis))
    moveDir.addInPlace(right.scale(strafeAxis))
    moveDir.y += verticalAxis
    fly.position.addInPlace(moveDir.scale(speed))
  }

  scene.registerBeforeRender(function () {
    moveCamera(Math.min(engine.getDeltaTime(), 100) / 1000)

    // Snapshots arrive at ~15Hz; easing toward them keeps motion readable
    // without pretending to a precision the wire does not carry.
    for (var key in nodes) {
      var entry = nodes[key]
      var t = entry.target
      if (!t) { continue }
      tmpV.set(t.p[0], t.p[1], t.p[2])
      BABYLON.Vector3.LerpToRef(entry.node.position, tmpV, LERP, entry.node.position)
      tmpQ.set(t.q[0], t.q[1], t.q[2], t.q[3])
      BABYLON.Quaternion.SlerpToRef(entry.node.rotationQuaternion, tmpQ, LERP, entry.node.rotationQuaternion)
      entry.node.scaling.set(t.s[0], t.s[1], t.s[2])
    }

    // follow/eyes track the SELECTION, so clicking a peer and pressing either
    // mode rides that peer — not only the server's own player.
    var tracked = stateOf(selectedKey) || playerState
    if (tracked) {
      var p = tracked.p
      if (mode === 'follow') {
        tmpV.set(p[0], p[1] + HALF_HEIGHT, p[2])
        BABYLON.Vector3.LerpToRef(orbit.target, tmpV, 0.2, orbit.target)
      } else if (mode === 'eyes') {
        // Roughly eye level on that capsule, looking where its yaw points — for
        // the server's own player this is the closest thing to standing inside
        // the process.
        eyes.position.set(p[0], p[1] + PLAYER_HEIGHT * 0.94, p[2])
        var q = tracked.q
        eyes.rotationQuaternion = new BABYLON.Quaternion(q[0], q[1], q[2], q[3])
      }
    }

    var cam = scene.activeCamera
    el.campos.textContent =
      Math.round(cam.globalPosition.x) + ', ' + Math.round(cam.globalPosition.y) + ', ' + Math.round(cam.globalPosition.z)

    if (lastSnapshotAt) {
      var age = Math.round(performance.now() - lastSnapshotAt)
      el.age.textContent = age + 'ms'
      el.age.className = age > 1000 ? 'bad' : (age > 300 ? 'warn' : '')
    }
  })

  engine.runRenderLoop(function () {
    scene.render()
    el.fps.textContent = engine.getFps().toFixed(0)
  })
  window.addEventListener('resize', function () { engine.resize() })
})()
</script>
</body>
</html>
`
