const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Admin password (set ADMIN_PASSWORD env var, default: 'admin') ───
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  if (token !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// Admin API: stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const now = Date.now();
  const roomList = [];
  for (const [code, room] of rooms) {
    const p1Connected = room.players.p1 && room.players.p1.readyState === WebSocket.OPEN;
    const p2Connected = room.players.p2 && room.players.p2.readyState === WebSocket.OPEN;
    const state = room.state;
    const flagsP1 = (state.flags || []).filter(f => f.winner === 'p1').length;
    const flagsP2 = (state.flags || []).filter(f => f.winner === 'p2').length;
    roomList.push({
      code,
      names: room.names,
      players: { p1: p1Connected, p2: p2Connected },
      created: room.created,
      ageMinutes: Math.floor((now - room.created) / 60000),
      turn: state.turn,
      phase: state.phase,
      flags: { p1: flagsP1, p2: flagsP2 },
      gameOver: state.gameOver,
      winner: state.winner,
      winType: state.winType,
      troopDeckSize: (state.troopDeck || []).length,
      tacticsDeckSize: (state.tacticsDeck || []).length,
    });
  }
  roomList.sort((a, b) => b.created - a.created);
  res.json({
    totalRooms: rooms.size,
    activeRooms: roomList.filter(r => !r.gameOver).length,
    completedRooms: roomList.filter(r => r.gameOver).length,
    connectedPlayers: roomList.reduce((n, r) => n + (r.players.p1 ? 1 : 0) + (r.players.p2 ? 1 : 0), 0),
    rooms: roomList,
    serverUptime: Math.floor(process.uptime()),
  });
});

// Admin API: force-close a room
app.delete('/api/admin/rooms/:code', requireAdmin, (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room) { res.status(404).json({ error: 'Room not found' }); return; }
  const msg = JSON.stringify({ type: 'opponent_disconnected' });
  if (room.players.p1 && room.players.p1.readyState === WebSocket.OPEN) room.players.p1.send(msg);
  if (room.players.p2 && room.players.p2.readyState === WebSocket.OPEN) room.players.p2.send(msg);
  rooms.delete(code);
  res.json({ ok: true, deleted: code });
});

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Catch-all: serve index.html for any path (so /room/WOLF42 works too)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Room storage ───────────────────────────────────────────────
// rooms[code] = { code, state, players: { p1: ws|null, p2: ws|null }, names: { p1, p2 }, created }
const rooms = new Map();

// Clean up empty rooms after 3 hours
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.created < cutoff) rooms.delete(code);
  }
}, 10 * 60 * 1000);

// ─── Game logic (server-authoritative) ──────────────────────────
const COLORS = ['RED', 'ORANGE', 'YELLOW', 'GREEN', 'BLUE', 'PURPLE'];
const TACTICS = [
  { id: 't_alex',    name: 'Alexander',        type: 'leader',   cat: 'morale', sym: '👑' },
  { id: 't_dar',     name: 'Darius',           type: 'leader',   cat: 'morale', sym: '👑' },
  { id: 't_comp',    name: 'Companion Cav.',   type: 'companion',cat: 'morale', sym: '🐴' },
  { id: 't_shield',  name: 'Shield Bearers',   type: 'shield',   cat: 'morale', sym: '🛡️' },
  { id: 't_fog',     name: 'Fog',              type: 'fog',      cat: 'env',    sym: '🌫️' },
  { id: 't_mud',     name: 'Mud',              type: 'mud',      cat: 'env',    sym: '🪨' },
  { id: 't_scout',   name: 'Scout',            type: 'scout',    cat: 'guile',  sym: '🔭' },
  { id: 't_redeploy',name: 'Redeploy',         type: 'redeploy', cat: 'guile',  sym: '↩️' },
  { id: 't_deserter',name: 'Deserter',         type: 'deserter', cat: 'guile',  sym: '⚡' },
  { id: 't_traitor', name: 'Traitor',          type: 'traitor',  cat: 'guile',  sym: '🗡️' },
];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildInitialState() {
  let troops = [];
  for (const c of COLORS) for (let v = 1; v <= 10; v++) troops.push({ id: `${c}_${v}`, color: c, value: v, type: 'troop' });
  shuffle(troops);
  const tacs = TACTICS.map(t => ({ ...t }));
  shuffle(tacs);
  return {
    troopDeck: troops.slice(14),
    tacticsDeck: tacs,
    hands: { p1: troops.slice(0, 7), p2: troops.slice(7, 14) },
    flags: Array.from({ length: 9 }, (_, i) => ({ id: i, winner: null, slots: { p1: [], p2: [] }, env: [] })),
    tacticsPlayed: { p1: 0, p2: 0 },
    discards: { p1: [], p2: [] },
    turn: 'p1',
    phase: 'play',
    gameOver: false,
    winner: null,
    winType: null,
  };
}

function opp(p) { return p === 'p1' ? 'p2' : 'p1'; }

// Formation evaluation
function hasFog(flag) { return flag.env && flag.env.some(e => e.type === 'fog'); }
function hasMud(flag) { return flag.env && flag.env.some(e => e.type === 'mud'); }
function slotsNeeded(flag) { return hasMud(flag) ? 4 : 3; }

function resolveCards(slots) {
  return slots.map(c => c._res || c).filter(c => c && c.type === 'troop');
}

function formationType(cards, fog = false) {
  const r = cards.filter(c => c && c.type === 'troop');
  if (r.length < 3) return null;
  if (fog) return { rank: 0, sum: r.reduce((s, c) => s + (c.value || 0), 0), name: 'Fog' };
  const vals = r.map(c => c.value).sort((a, b) => a - b);
  const cols = r.map(c => c.color);
  const sum = vals.reduce((s, v) => s + v, 0);
  const sameColor = cols.every(c => c === cols[0]);
  const consec = vals[2] - vals[1] === 1 && vals[1] - vals[0] === 1;
  if (sameColor && consec) return { rank: 5, sum, name: 'Wedge' };
  if (vals[0] === vals[1] && vals[1] === vals[2]) return { rank: 4, sum, name: 'Phalanx' };
  if (sameColor) return { rank: 3, sum, name: 'Battalion' };
  if (consec) return { rank: 2, sum, name: 'Skirmish' };
  return { rank: 1, sum, name: 'Host' };
}

function cmpF(a, b) {
  if (!a) return -1;
  if (!b) return 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.sum - b.sum;
}

function flagForm(flag, player) {
  return formationType(resolveCards(flag.slots[player]), hasFog(flag));
}

function canProveWin(state, flagIdx, claimer) {
  const flag = state.flags[flagIdx];
  const needed = slotsNeeded(flag);
  const mine = flag.slots[claimer];
  if (mine.length < needed) return false;
  const myF = flagForm(flag, claimer);
  if (!myF) return false;
  const theirs = flag.slots[opp(claimer)];
  if (theirs.length === needed) return cmpF(myF, flagForm(flag, opp(claimer))) > 0;

  const used = new Set();
  state.flags.forEach(f => {
    [...f.slots.p1, ...f.slots.p2].forEach(c => c.type === 'troop' && used.add(c.id));
  });
  state.hands.p1.forEach(c => c.type === 'troop' && used.add(c.id));
  state.hands.p2.forEach(c => c.type === 'troop' && used.add(c.id));
  (state.discards.p1 || []).forEach(c => c.type === 'troop' && used.add(c.id));
  (state.discards.p2 || []).forEach(c => c.type === 'troop' && used.add(c.id));

  const avail = [];
  for (const c of COLORS) for (let v = 1; v <= 10; v++) {
    const id = `${c}_${v}`;
    if (!used.has(id)) avail.push({ id, color: c, value: v, type: 'troop' });
  }
  const left = needed - theirs.length;
  if (left <= 0) return cmpF(myF, flagForm(flag, opp(claimer))) > 0;

  let best = null;
  const top = avail.slice(0, 25);
  function pick(i, chosen) {
    if (chosen.length === left) {
      const f = formationType([...theirs, ...chosen], hasFog(flag));
      if (!best || cmpF(f, best) > 0) best = f;
      return;
    }
    for (let j = i; j < top.length; j++) pick(j + 1, [...chosen, top[j]]);
  }
  pick(0, []);
  return cmpF(myF, best) > 0;
}

function canClaim(state, flagIdx, claimer) {
  const flag = state.flags[flagIdx];
  if (!flag || flag.winner) return false;
  const needed = slotsNeeded(flag);
  const mine = flag.slots[claimer];
  const theirs = flag.slots[opp(claimer)];
  if (mine.length < needed) return false;
  const myF = flagForm(flag, claimer);
  if (theirs.length === needed) {
    const oppF = flagForm(flag, opp(claimer));
    return cmpF(myF, oppF) > 0 || (cmpF(myF, oppF) === 0 && theirs.length >= mine.length);
  }
  return canProveWin(state, flagIdx, claimer);
}

function checkWin(state) {
  for (const p of ['p1', 'p2']) {
    const won = state.flags.map((f, i) => f.winner === p ? i : -1).filter(i => i >= 0);
    if (won.length >= 5) return { winner: p, type: 'Envelopment' };
    for (let i = 0; i <= 6; i++) {
      if (state.flags[i].winner === p && state.flags[i + 1].winner === p && state.flags[i + 2].winner === p)
        return { winner: p, type: 'Breakthrough' };
    }
  }
  return null;
}

// ─── Message handlers ────────────────────────────────────────────
function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  send(room.players.p1, msg);
  send(room.players.p2, msg);
}

function sendGameState(room) {
  const { state, names } = room;
  // Send each player their own perspective (hide opponent's deck order but show hand sizes)
  for (const role of ['p1', 'p2']) {
    const ws = room.players[role];
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    send(ws, {
      type: 'state',
      state: {
        ...state,
        // Each player sees their own hand fully, opponent hand as count only
        hands: {
          [role]: state.hands[role],
          [opp(role)]: state.hands[opp(role)].map(() => ({ type: 'hidden' })),
        },
        troopDeckSize: state.troopDeck.length,
        tacticsDeckSize: state.tacticsDeck.length,
      },
      myRole: role,
      names,
    });
  }
}

function genCode() {
  const words = ['WOLF', 'IRON', 'GOLD', 'FIRE', 'OAK', 'HAWK', 'PIKE', 'MACE', 'BOLT', 'VEIL', 'ASH', 'STORM'];
  return words[Math.floor(Math.random() * words.length)] + Math.floor(10 + Math.random() * 90);
}

function handleMessage(ws, data, role, roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const { state } = room;

  if (data.type === 'play_card') {
    const { flagIdx, cardId, resolvedAs } = data;
    if (state.turn !== role || state.phase !== 'play' || state.gameOver) return;
    const flag = state.flags[flagIdx];
    if (!flag || flag.winner) return;
    const needed = slotsNeeded(flag);
    if (flag.slots[role].length >= needed) return;

    const handIdx = state.hands[role].findIndex(c => c.id === cardId);
    if (handIdx === -1) return;
    const card = state.hands[role][handIdx];

    // Tactics restrictions
    if (card.type !== 'troop') {
      const tc = TACTICS.find(t => t.id === card.id);
      if (!tc) return;
      if (state.tacticsPlayed[role] > state.tacticsPlayed[opp(role)]) return;

      if (tc.cat === 'guile') {
        // Handled separately via their own message types
        return;
      }
      if (tc.cat === 'env') {
        if (hasFog(flag) || hasMud(flag)) return;
        state.hands[role].splice(handIdx, 1);
        flag.env.push({ ...card, ...tc });
        state.tacticsPlayed[role]++;
      } else {
        // Morale — goes into slot, may need resolution
        if (tc.type === 'leader') {
          if (flag.slots[role].some(c => c.type === 'leader')) return;
          if (state.flags.some(f => f.slots[role].some(c => c.type === 'leader'))) return;
        }
        const placed = { ...card, ...tc };
        if (resolvedAs) placed._res = resolvedAs;
        state.hands[role].splice(handIdx, 1);
        flag.slots[role].push(placed);
        state.tacticsPlayed[role]++;
      }
    } else {
      state.hands[role].splice(handIdx, 1);
      flag.slots[role].push({ ...card });
    }

    state.phase = 'draw';
    sendGameState(room);
    return;
  }

  if (data.type === 'draw_card') {
    if (state.turn !== role || state.phase !== 'draw' || state.gameOver) return;
    const { deck } = data;
    let card = null;
    if (deck === 'troop') {
      if (!state.troopDeck.length) return;
      card = state.troopDeck.shift();
    } else {
      if (!state.tacticsDeck.length) return;
      card = state.tacticsDeck.shift();
    }
    state.hands[role].push(card);
    state.phase = 'play';
    state.turn = opp(role);
    sendGameState(room);
    return;
  }

  if (data.type === 'claim_flag') {
    if (state.turn !== role || state.gameOver) return;
    const { flagIdx } = data;
    if (!canClaim(state, flagIdx, role)) return;
    state.flags[flagIdx].winner = role;
    const result = checkWin(state);
    if (result) {
      state.gameOver = true;
      state.winner = result.winner;
      state.winType = result.type;
    }
    sendGameState(room);
    return;
  }

  if (data.type === 'tactic_scout') {
    if (state.turn !== role || state.phase !== 'play' || state.gameOver) return;
    if (state.tacticsPlayed[role] > state.tacticsPlayed[opp(role)]) return;
    const { cardId } = data;
    const handIdx = state.hands[role].findIndex(c => c.id === cardId);
    if (handIdx === -1) return;
    state.hands[role].splice(handIdx, 1);
    state.tacticsPlayed[role]++;
    // Draw 3
    const drawn = [];
    for (let i = 0; i < 3; i++) {
      if (state.troopDeck.length) drawn.push({ from: 'troop', card: state.troopDeck.shift() });
      else if (state.tacticsDeck.length) drawn.push({ from: 'tactics', card: state.tacticsDeck.shift() });
    }
    drawn.forEach(d => state.hands[role].push(d.card));
    state.phase = 'scout_return'; // Special phase: must return 2 cards
    sendGameState(room);
    // Also tell the active player which cards they drew
    send(ws, { type: 'scout_drew', cards: drawn.map(d => d.card) });
    return;
  }

  if (data.type === 'scout_return') {
    if (state.phase !== 'scout_return' || state.turn !== role) return;
    const { cardIds } = data; // array of 2 card ids to return
    if (!cardIds || cardIds.length !== 2) return;
    for (const id of cardIds) {
      const idx = state.hands[role].findIndex(c => c.id === id);
      if (idx === -1) continue;
      const card = state.hands[role].splice(idx, 1)[0];
      if (card.type === 'troop') state.troopDeck.unshift(card);
      else state.tacticsDeck.unshift(card);
    }
    state.phase = 'draw';
    sendGameState(room);
    return;
  }

  if (data.type === 'tactic_guile') {
    // Redeploy, Deserter, Traitor - client sends the full resolved action
    if (state.turn !== role || state.phase !== 'play' || state.gameOver) return;
    if (state.tacticsPlayed[role] > state.tacticsPlayed[opp(role)]) return;
    const { cardId, action } = data;
    const handIdx = state.hands[role].findIndex(c => c.id === cardId);
    if (handIdx === -1) return;
    const card = state.hands[role][handIdx];
    const tc = TACTICS.find(t => t.id === card.id);
    if (!tc || tc.cat !== 'guile') return;

    state.hands[role].splice(handIdx, 1);
    state.tacticsPlayed[role]++;

    if (tc.type === 'redeploy') {
      const { fromFlag, fromIdx, toFlag, discard } = action;
      const srcFlag = state.flags[fromFlag];
      if (!srcFlag || srcFlag.winner) { sendGameState(room); return; }
      const removed = srcFlag.slots[role].splice(fromIdx, 1)[0];
      if (discard) {
        state.discards[role].push(removed);
      } else {
        const dst = state.flags[toFlag];
        if (dst && !dst.winner && dst.slots[role].length < slotsNeeded(dst)) dst.slots[role].push(removed);
        else state.discards[role].push(removed);
      }
    } else if (tc.type === 'deserter') {
      const { fromFlag, fromIdx } = action;
      const srcFlag = state.flags[fromFlag];
      if (!srcFlag || srcFlag.winner) { sendGameState(room); return; }
      const removed = srcFlag.slots[opp(role)].splice(fromIdx, 1)[0];
      state.discards[opp(role)].push(removed);
    } else if (tc.type === 'traitor') {
      const { fromFlag, fromIdx, toFlag } = action;
      const srcFlag = state.flags[fromFlag];
      if (!srcFlag || srcFlag.winner) { sendGameState(room); return; }
      const card2 = srcFlag.slots[opp(role)][fromIdx];
      if (!card2 || card2.type !== 'troop') { sendGameState(room); return; }
      srcFlag.slots[opp(role)].splice(fromIdx, 1);
      const dst = state.flags[toFlag];
      if (dst && !dst.winner && dst.slots[role].length < slotsNeeded(dst)) dst.slots[role].push(card2);
      else state.discards[role].push(card2);
    }

    state.phase = 'draw';
    sendGameState(room);
    return;
  }

  if (data.type === 'pass') {
    // Pass when no legal plays
    if (state.turn !== role || state.phase !== 'play') return;
    state.phase = 'draw';
    sendGameState(room);
    return;
  }

  if (data.type === 'rematch') {
    room.state = buildInitialState();
    broadcast(room, { type: 'rematch' });
    sendGameState(room);
    return;
  }
}

// ─── WebSocket connection ─────────────────────────────────────────
wss.on('connection', (ws) => {
  let myRoom = null;
  let myRole = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'create_room') {
      const code = genCode();
      const state = buildInitialState();
      const room = {
        code,
        state,
        players: { p1: ws, p2: null },
        names: { p1: data.name || 'Player 1', p2: '' },
        created: Date.now(),
      };
      rooms.set(code, room);
      myRoom = code;
      myRole = 'p1';
      send(ws, { type: 'room_created', code, role: 'p1' });
      return;
    }

    if (data.type === 'join_room') {
      const code = (data.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, { type: 'error', msg: 'Room not found.' }); return; }
      if (room.players.p2) { send(ws, { type: 'error', msg: 'Room is full.' }); return; }
      room.players.p2 = ws;
      room.names.p2 = data.name || 'Player 2';
      myRoom = code;
      myRole = 'p2';
      send(ws, { type: 'room_joined', code, role: 'p2' });
      // Notify p1 that opponent joined
      send(room.players.p1, { type: 'opponent_joined', name: room.names.p2 });
      sendGameState(room);
      return;
    }

    if (myRoom && myRole) {
      handleMessage(ws, data, myRole, myRoom);
    }
  });

  ws.on('close', () => {
    if (!myRoom) return;
    const room = rooms.get(myRoom);
    if (!room) return;
    // Notify opponent
    const oppWs = room.players[opp(myRole)];
    send(oppWs, { type: 'opponent_disconnected' });
    // Clear slot but keep room alive for reconnect (simple: just null the slot)
    room.players[myRole] = null;
    // If both disconnected, clean up
    if (!room.players.p1 && !room.players.p2) rooms.delete(myRoom);
  });

  ws.on('error', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Battle Line running on port ${PORT}`));
