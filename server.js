const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.json({
    message: "Poker Tournament Server",
    status: "OK",
    timestamp: new Date().toISOString(),
    endpoints: { health: "/health", socket: "ws://" + req.get("host") + "/socket.io/" },
    version: "1.0.0",
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
  });
});

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
  allowEIO3: true,
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8,
});

const PORT = process.env.PORT || 3000;

const rooms = new Map();
const players = new Map();

// ========== UTILITY FUNCTIONS ==========
const generateRoomCode = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
};

const createDeck = () => {
  const suits = ["hearts", "diamonds", "clubs", "spades"];
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ rank, suit, value: getCardValue(rank), symbol: getCardSymbol(suit) });
    }
  }
  return deck;
};

const getCardValue = (rank) => {
  const values = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13, A: 14 };
  return values[rank];
};

const getCardSymbol = (suit) => {
  const symbols = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" };
  return symbols[suit];
};

const shuffleDeck = (deck) => {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
};

// Đánh giá bộ 3 lá
const evaluateHand = (cards) => {
  const sorted = [...cards].sort((a, b) => b.value - a.value);
  const values = sorted.map(c => c.value);
  const ranks = sorted.map(c => c.rank);
  const suits = sorted.map(c => c.suit);

  if (ranks[0] === ranks[1] && ranks[1] === ranks[2]) {
    return { type: "three-of-a-kind", value: values[0] * 100, description: `Ba lá ${ranks[0]}` };
  }
  const isSameSuit = suits.every(s => s === suits[0]);
  const isStraight = (values[0] - values[1] === 1 && values[1] - values[2] === 1) ||
                     (values[0] === 14 && values[1] === 3 && values[2] === 2); // A-2-3
  if (isSameSuit && isStraight) {
    return { type: "straight-flush", value: values[0] * 1000, description: `Sảnh đồng chất ${sorted[0].rank}` };
  }
  if (isSameSuit) {
    return { type: "flush", value: values[0] * 10000 + values[1] * 100 + values[2], description: `Đồng chất ${suits[0]}` };
  }
  if (isStraight) {
    return { type: "straight", value: values[0] * 100, description: `Sảnh ${sorted[0].rank}` };
  }
  if (ranks[0] === ranks[1]) return { type: "pair", value: values[0] * 100 + values[2], description: `Đôi ${ranks[0]}` };
  if (ranks[1] === ranks[2]) return { type: "pair", value: values[1] * 100 + values[0], description: `Đôi ${ranks[1]}` };
  return { type: "high-card", value: values[0] * 10000 + values[1] * 100 + values[2], description: `Lẻ ${sorted[0].rank} cao` };
};

const compareHands = (h1, h2) => {
  const types = { "high-card": 1, pair: 2, straight: 3, flush: 4, "straight-flush": 5, "three-of-a-kind": 6 };
  if (types[h1.type] > types[h2.type]) return 1;
  if (types[h1.type] < types[h2.type]) return -1;
  if (h1.value > h2.value) return 1;
  if (h1.value < h2.value) return -1;
  return 0;
};

// ---------- QUẢN LÝ LƯỢT CHƠI ----------
const getNextActivePlayerIndex = (room, startIndex) => {
  const n = room.players.length;
  if (n === 0) return -1;
  let idx = (startIndex + 1) % n;
  let count = 0;
  while (count < n) {
    const p = room.players[idx];
    if (!p.folded && p.money > 0 && !p.allIn) return idx;
    idx = (idx + 1) % n;
    count++;
  }
  return -1;
};

const getFirstPlayerAfterDealer = (room) => {
  if (room.players.length === 0) return -1;
  let idx = (room.dealerIndex + 1) % room.players.length;
  let count = 0;
  while (count < room.players.length) {
    const p = room.players[idx];
    if (!p.folded && p.money > 0) return idx;
    idx = (idx + 1) % room.players.length;
    count++;
  }
  return -1;
};

// ---------- BẮT ĐẦU VÁN MỚI ----------
const startNewHand = (room) => {
  console.log(`🃏 New hand - Room: ${room.code}`);

  room.pot = 0;
  room.minBet = 100;
  room.currentRound = 1;
  room.betHistory = [];
  room.lastRaise = null;
  room.deck = shuffleDeck(createDeck());

  // Reset trạng thái người chơi
  room.players.forEach((p) => {
    p.hand = [];
    p.viewedCards = false;
    p.folded = false;
    p.currentBet = 0;
    p.allIn = false;
    p.actedThisRound = false;

    if (p.money > 0) {
      const ante = Math.min(100, p.money);
      p.money -= ante;
      p.currentBet = ante;
      room.pot += ante;
      for (let i = 0; i < 3; i++) if (room.deck.length) p.hand.push(room.deck.pop());
    } else {
      p.folded = true; // hết tiền tự động bỏ
    }
  });

  // Xoay dealer
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  room.currentTurn = getFirstPlayerAfterDealer(room);
  room.handsPlayed = (room.handsPlayed || 0) + 1;

  console.log(`   Dealer: ${room.dealerIndex}, Turn: ${room.currentTurn}, Pot: ${room.pot}`);
  return room;
};

// ---------- KIỂM TRA KẾT THÚC VÁN ----------
const isHandFinished = (room) => {
  const active = room.players.filter(p => !p.folded && p.money > 0);
  if (active.length <= 1) return true;
  const canAct = active.filter(p => !p.allIn && p.money > 0);
  return canAct.length === 0;
};

// ---------- GIẢI QUYẾT KẾT THÚC VÁN ----------
const resolveHand = (room) => {
  const active = room.players.filter(p => !p.folded && p.money > 0);

  if (active.length === 0) {
    return { winner: null, eliminated: [], pot: room.pot };
  }

  let winners = [];
  if (active.length === 1) {
    winners = [active[0]];
  } else {
    const evaluated = active.map(p => ({ player: p, eval: evaluateHand(p.hand) }));
    evaluated.sort((a, b) => compareHands(b.eval, a.eval));
    const bestScore = evaluated[0].eval.value;
    winners = evaluated.filter(e => e.eval.value === bestScore).map(e => e.player);
  }

  if (winners.length > 1) {
    const share = Math.floor(room.pot / winners.length);
    winners.forEach(w => w.money += share);
  } else if (winners.length === 1) {
    winners[0].money += room.pot;
  }

  const eliminated = room.players.filter(p => p.money <= 0);
  return { winner: winners[0] || null, eliminated, pot: room.pot };
};

// ---------- XỬ LÝ SAU KHI KẾT THÚC VÁN ----------
const afterHandEnded = (room, socketio) => {
  room.tournamentPlayers = room.tournamentPlayers.filter(tp => tp.money > 0);
  const tournamentEnded = room.tournamentPlayers.length <= 1 ||
                          room.handsPlayed >= room.startingPlayerCount;

  if (tournamentEnded) {
    room.gameState = "ended";
    const rankings = [...room.players].sort((a, b) => b.money - a.money);
    const champ = room.tournamentPlayers[0] || null;
    socketio.to(room.code).emit("tournament-ended", { winner: champ, rankings });
    return true;
  }

  setTimeout(() => {
    const newRoom = startNewHand(room);
    rooms.set(room.code, newRoom);
    socketio.to(room.code).emit("new-hand-started", newRoom);
  }, 3000);
  return false;
};

// ========== SOCKET.IO HANDLERS ==========
io.on("connection", (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);

  socket.emit("connected", { socketId: socket.id, message: "Connected", timestamp: Date.now() });

  socket.on("ping", () => socket.emit("pong", { timestamp: Date.now() }));

  socket.on("get-room-info", (roomCode) => {
    const room = rooms.get(roomCode);
    room ? socket.emit("room-updated", room) : socket.emit("error", { message: "Phòng không tồn tại" });
  });

  // ---------- TẠO PHÒNG ----------
  socket.on("create-room", (playerName) => {
    if (!playerName?.trim()) return socket.emit("error", { message: "Tên không hợp lệ" });
    try {
      const roomCode = generateRoomCode();
      const playerId = socket.id;
      const room = {
        code: roomCode,
        host: playerId,
        players: [{
          id: playerId,
          name: playerName.trim(),
          money: 10000,
          hand: [],
          viewedCards: false,
          folded: false,
          currentBet: 0,
          position: 0,
          connected: true,
          allIn: false,
        }],
        gameState: "waiting",
        currentRound: 0,
        dealerIndex: -1,
        pot: 0,
        deck: [],
        currentTurn: 0,
        minBet: 100,
        tournamentRound: 0,
        tournamentPlayers: [],
        betHistory: [],
        lastRaise: null,
        createdAt: new Date().toISOString(),
        settings: { entryFee: 100, minPlayers: 2, maxPlayers: 8 },
      };
      rooms.set(roomCode, room);
      players.set(playerId, { roomCode, playerName: playerName.trim(), socketId: socket.id });
      socket.join(roomCode);
      socket.emit("room-created", { roomCode, playerId, message: "Phòng đã được tạo" });
      io.to(roomCode).emit("room-updated", room);
    } catch (err) {
      socket.emit("error", { message: "Lỗi tạo phòng: " + err.message });
    }
  });

  // ---------- VÀO PHÒNG ----------
  socket.on("join-room", ({ roomCode, playerName }) => {
    if (!roomCode || !playerName) return socket.emit("error", { message: "Thiếu thông tin" });
    const room = rooms.get(roomCode.toUpperCase());
    if (!room) return socket.emit("error", { message: "Phòng không tồn tại" });
    if (room.gameState !== "waiting") return socket.emit("error", { message: "Phòng đã bắt đầu" });
    if (room.players.length >= 8) return socket.emit("error", { message: "Phòng đầy" });
    if (room.players.some(p => p.name.toLowerCase() === playerName.trim().toLowerCase())) {
      return socket.emit("error", { message: "Tên đã tồn tại" });
    }
    try {
      const player = {
        id: socket.id,
        name: playerName.trim(),
        money: 10000,
        hand: [],
        viewedCards: false,
        folded: false,
        currentBet: 0,
        position: room.players.length,
        connected: true,
        allIn: false,
      };
      room.players.push(player);
      players.set(socket.id, { roomCode: roomCode.toUpperCase(), playerName: playerName.trim(), socketId: socket.id });
      socket.join(roomCode.toUpperCase());
      socket.emit("room-joined", { roomCode: roomCode.toUpperCase(), playerId: socket.id, message: "Đã vào phòng" });
      io.to(roomCode.toUpperCase()).emit("room-updated", room);
    } catch (err) {
      socket.emit("error", { message: "Lỗi vào phòng: " + err.message });
    }
  });

  // ---------- BẮT ĐẦU GAME ----------
  socket.on("start-game", (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("error", { message: "Phòng không tồn tại" });
    if (room.host !== socket.id) return socket.emit("error", { message: "Chỉ chủ phòng" });
    if (room.players.length < 2) return socket.emit("error", { message: "Cần ít nhất 2 người" });

    room.gameState = "playing";
    room.tournamentRound = 1;
    room.tournamentPlayers = [...room.players];
    room.startingPlayerCount = room.players.length;
    room.handsPlayed = 0;

    const updatedRoom = startNewHand(room);
    rooms.set(roomCode, updatedRoom);
    io.to(roomCode).emit("game-started", updatedRoom);
  });

  // ---------- XEM BÀI ----------
  socket.on("view-cards", (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("error", { message: "Phòng không tồn tại" });
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return socket.emit("error", { message: "Không tìm thấy người chơi" });
    if (player.viewedCards) return socket.emit("error", { message: "Đã xem bài rồi" });
    if (room.currentTurn !== room.players.indexOf(player)) {
      return socket.emit("error", { message: "Chưa đến lượt của bạn" });
    }

    player.viewedCards = true;
    socket.emit("cards-revealed", { cards: player.hand, handEvaluation: evaluateHand(player.hand) });
    io.to(roomCode).emit("player-action-notification", {
      playerId: socket.id,
      playerName: player.name,
      action: "view-cards",
      message: `${player.name} đã xem bài`,
      timestamp: new Date().toISOString(),
    });
    io.to(roomCode).emit("room-updated", room);
  });

  // ---------- ĐẶT CƯỢC (ĐÃ SỬA LOGIC MINBET) ----------
  socket.on("place-bet", ({ roomCode, amount }) => {
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("error", { message: "Phòng không tồn tại" });
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return socket.emit("error", { message: "Người chơi không tồn tại" });
    if (player.folded) return socket.emit("error", { message: "Đã bỏ bài" });
    if (room.currentTurn !== room.players.indexOf(player)) {
      return socket.emit("error", { message: "Chưa đến lượt của bạn" });
    }

    const declaredAmount = parseInt(amount);
    // Kiểm tra số tiền tuyên bố phải >= mức cược tối thiểu hiện tại
    if (declaredAmount < room.minBet) {
      return socket.emit("error", { message: `Cược tối thiểu là ${room.minBet} xu` });
    }

    // Tính số tiền thực tế phải trả dựa trên việc đã xem bài chưa
    let actualAmount = declaredAmount;
    if (!player.viewedCards) {
      actualAmount = Math.floor(declaredAmount / 2);
    }

    if (player.money < actualAmount) {
      return socket.emit("error", { message: "Không đủ tiền" });
    }

    // Thực hiện cược
    player.money -= actualAmount;
    player.currentBet += actualAmount;
    room.pot += actualAmount;
    player.actedThisRound = true;

    // Cập nhật mức cược tối thiểu nếu declaredAmount lớn hơn minBet hiện tại
    if (declaredAmount > room.minBet) {
      room.minBet = declaredAmount;
      room.lastRaise = socket.id;
    }

    room.betHistory.push({
      playerId: socket.id,
      playerName: player.name,
      declaredAmount,
      actualAmount,
      viewedCards: player.viewedCards,
      timestamp: new Date().toISOString(),
    });

    // Chuyển lượt
    room.currentTurn = getNextActivePlayerIndex(room, room.players.indexOf(player));

    io.to(roomCode).emit("player-action-notification", {
      playerId: socket.id,
      playerName: player.name,
      action: "bet",
      declaredAmount,
      actualAmount,
      message: `${player.name} cược ${declaredAmount.toLocaleString()} xu${!player.viewedCards ? ` (thực tế ${actualAmount} xu)` : ""}`,
    });

    io.to(roomCode).emit("room-updated", room);

    // Kiểm tra kết thúc vòng
    if (isRoundComplete(room)) checkAndAdvanceRound(room);

    // Kiểm tra kết thúc ván
    if (isHandFinished(room)) {
      const result = resolveHand(room);
      io.to(roomCode).emit("hand-ended", { winner: result.winner, pot: result.pot });
      room.tournamentPlayers = room.tournamentPlayers.filter(tp => tp.money > 0);
      afterHandEnded(room, io);
    }
  });

  // ---------- BỎ BÀI ----------
  socket.on("fold", (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("error", { message: "Phòng không tồn tại" });
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return socket.emit("error", { message: "Người chơi không tồn tại" });
    if (player.folded) return socket.emit("error", { message: "Đã bỏ bài rồi" });
    if (room.currentTurn !== room.players.indexOf(player)) {
      return socket.emit("error", { message: "Chưa đến lượt của bạn" });
    }

    player.folded = true;
    player.actedThisRound = true;
    room.currentTurn = getNextActivePlayerIndex(room, room.players.indexOf(player));

    io.to(roomCode).emit("player-action-notification", {
      playerId: socket.id,
      playerName: player.name,
      action: "fold",
      message: `${player.name} đã bỏ bài`,
    });
    io.to(roomCode).emit("room-updated", room);

    if (isRoundComplete(room)) checkAndAdvanceRound(room);

    if (isHandFinished(room)) {
      const result = resolveHand(room);
      io.to(roomCode).emit("hand-ended", { winner: result.winner, pot: result.pot });
      room.tournamentPlayers = room.tournamentPlayers.filter(tp => tp.money > 0);
      afterHandEnded(room, io);
    }
  });

  // ---------- ALL-IN ----------
  socket.on("all-in", (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("error", { message: "Phòng không tồn tại" });
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return socket.emit("error", { message: "Người chơi không tồn tại" });
    if (player.folded) return socket.emit("error", { message: "Đã bỏ bài" });
    if (player.allIn) return socket.emit("error", { message: "Đã all‑in" });
    if (room.currentTurn !== room.players.indexOf(player)) {
      return socket.emit("error", { message: "Chưa đến lượt của bạn" });
    }

    const allInAmount = player.money;
    player.money = 0;
    player.currentBet += allInAmount;
    room.pot += allInAmount;
    player.allIn = true;
    player.actedThisRound = true;

    // All-in không được giảm nửa, nhưng nếu chưa xem bài thì cũng không được giảm (vì all-in là bỏ hết)
    // declaredAmount coi như bằng allInAmount (vì không có khái niệm tuyên bố)
    if (allInAmount > room.minBet) {
      room.minBet = allInAmount;
      room.lastRaise = socket.id;
    }

    room.currentTurn = getNextActivePlayerIndex(room, room.players.indexOf(player));

    io.to(roomCode).emit("player-action-notification", {
      playerId: socket.id,
      playerName: player.name,
      action: "all-in",
      amount: allInAmount,
      message: `${player.name} ALL-IN ${allInAmount.toLocaleString()} xu!`,
    });
    io.to(roomCode).emit("room-updated", room);

    if (isRoundComplete(room)) checkAndAdvanceRound(room);

    if (isHandFinished(room)) {
      const result = resolveHand(room);
      io.to(roomCode).emit("hand-ended", { winner: result.winner, pot: result.pot });
      room.tournamentPlayers = room.tournamentPlayers.filter(tp => tp.money > 0);
      afterHandEnded(room, io);
    }
  });

  // ---------- SO BÀI ----------
  socket.on("compare-cards", ({ roomCode, targetPlayerId }) => {
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("error", { message: "Phòng không tồn tại" });
    const player = room.players.find(p => p.id === socket.id);
    const opponent = room.players.find(p => p.id === targetPlayerId);
    if (!player || !opponent) return socket.emit("error", { message: "Người chơi không tồn tại" });
    if (player.folded || opponent.folded) return socket.emit("error", { message: "Một trong hai đã bỏ bài" });
    if (room.currentRound < 2) return socket.emit("error", { message: "Chỉ so bài từ vòng 2" });
    if (room.currentTurn !== room.players.indexOf(player)) {
      return socket.emit("error", { message: "Chưa đến lượt của bạn" });
    }
    // Kiểm tra đã đặt cược đủ (theo mức minBet hiện tại) chưa? 
    // Ở đây ta dùng currentBet thực tế? Hay dùng declared? 
    // Theo luật, để được so bài, người chơi phải "theo" ít nhất bằng mức cược hiện tại (minBet). 
    // Nhưng currentBet của họ là tiền thực tế, không phản ánh đúng nếu họ chưa xem. 
    // Tốt nhất nên so sánh số tiền họ đã bỏ (currentBet) với mức cần thiết quy đổi? 
    // Đơn giản: yêu cầu họ phải có currentBet ít nhất bằng minBet? Không đúng vì người chưa xem có currentBet thấp hơn.
    // Thay vào đó, ta kiểm tra xem họ đã "theo" chưa bằng cách xem liệu họ có thể tiếp tục hành động không? 
    // Trong thực tế, nếu họ chưa theo kịp, họ sẽ không được phép so bài. 
    // Ta có thể kiểm tra: nếu player.currentBet < room.minBet * (player.viewedCards ? 1 : 0.5) ? 
    // Nhưng minBet là số tuyên bố, không phải thực tế. 
    // Tạm thời giữ nguyên điều kiện cũ: player.currentBet >= room.minBet (vì currentBet là thực tế, và minBet là tuyên bố, không công bằng).
    // Để đơn giản, ta bỏ qua kiểm tra này và để server tự quyết định dựa trên luật chơi? 
    // Theo yêu cầu của người dùng: "phải đặt cược số tiền để theo trước rồi mới được so bài". 
    // Nghĩa là họ phải có currentBet (thực tế) ít nhất bằng mức cược tối thiểu hiện tại? Nhưng mức cược tối thiểu là số tuyên bố, không phải thực tế. 
    // Có lẽ nên hiểu: họ phải đặt cược đủ số tiền tương ứng với mức cược hiện tại, tức là nếu chưa xem thì họ phải bỏ ra một nửa số đó. 
    // Vậy ta kiểm tra: 
    //   let requiredActual = player.viewedCards ? room.minBet : Math.floor(room.minBet / 2);
    //   if (player.currentBet < requiredActual) return ... 
    // Nhưng currentBet của họ có thể đã có từ trước (ví dụ họ đã cược 50, minBet=100, chưa xem thì requiredActual=50, currentBet=50 là đủ). 
    // Điều này hợp lý.
    const requiredActual = player.viewedCards ? room.minBet : Math.floor(room.minBet / 2);
    if (player.currentBet < requiredActual) {
      return socket.emit("error", { message: "Bạn cần đặt cược đủ số tiền theo trước khi so bài" });
    }

    const hand1 = evaluateHand(player.hand);
    const hand2 = evaluateHand(opponent.hand);
    const result = compareHands(hand1, hand2);

    let winner, loser;
    if (result > 0) { winner = player; loser = opponent; }
    else if (result < 0) { winner = opponent; loser = player; }

    if (winner && loser) {
      loser.folded = true;
      socket.emit("compare-result", {
        opponent: opponent.name,
        winner: result > 0 ? "you" : "opponent",
        yourHand: player.hand,
        opponentHand: opponent.hand,
        yourEvaluation: hand1,
        opponentEvaluation: hand2,
        message: result > 0 ? "🎉 Bạn thắng!" : "😞 Bạn thua!",
      });
      io.to(opponent.id).emit("compare-result", {
        opponent: player.name,
        winner: result < 0 ? "you" : "opponent",
        yourHand: opponent.hand,
        opponentHand: player.hand,
        yourEvaluation: hand2,
        opponentEvaluation: hand1,
        message: result < 0 ? "🎉 Bạn thắng!" : "😞 Bạn thua!",
      });
    } else {
      socket.emit("compare-result", { winner: "draw", yourHand: player.hand, opponentHand: opponent.hand, yourEvaluation: hand1, opponentEvaluation: hand2, message: "🤝 Hòa!" });
      io.to(opponent.id).emit("compare-result", { winner: "draw", yourHand: opponent.hand, opponentHand: player.hand, yourEvaluation: hand2, opponentEvaluation: hand1, message: "🤝 Hòa!" });
    }

    player.actedThisRound = true;
    room.currentTurn = getNextActivePlayerIndex(room, room.players.indexOf(player));

    io.to(roomCode).emit("player-action-notification", {
      playerId: socket.id,
      playerName: player.name,
      action: "compare",
      targetPlayerId: opponent.id,
      targetPlayerName: opponent.name,
      message: `${player.name} đã so bài với ${opponent.name}!`,
    });
    io.to(roomCode).emit("room-updated", room);

    if (isRoundComplete(room)) checkAndAdvanceRound(room);

    if (isHandFinished(room)) {
      const result = resolveHand(room);
      io.to(roomCode).emit("hand-ended", { winner: result.winner, pot: result.pot });
      room.tournamentPlayers = room.tournamentPlayers.filter(tp => tp.money > 0);
      afterHandEnded(room, io);
    }
  });

  // ---------- KIỂM TRA KẾT THÚC VÒNG ----------
  const isRoundComplete = (room) => {
    const canAct = room.players.filter(p => !p.folded && p.money > 0 && !p.allIn);
    if (canAct.length === 0) return true;
    return canAct.every(p => p.actedThisRound);
  };

  const checkAndAdvanceRound = (room) => {
    const active = room.players.filter(p => !p.folded && p.money > 0);
    if (active.length <= 1) return false;
    room.players.forEach(p => { p.actedThisRound = false; });
    room.currentRound++;
    room.currentTurn = getFirstPlayerAfterDealer(room);
    console.log(`🔄 Room ${room.code} - Round ${room.currentRound}, Turn: ${room.currentTurn}`);
    return true;
  };

  // ---------- NGẮT KẾT NỐI ----------
  socket.on("disconnect", (reason) => {
    console.log(`❌ Client disconnected: ${socket.id}, reason: ${reason}`);
    const playerInfo = players.get(socket.id);
    if (!playerInfo) return;
    const room = rooms.get(playerInfo.roomCode);
    if (room) {
      const pIdx = room.players.findIndex(p => p.id === socket.id);
      if (pIdx > -1) {
        room.players[pIdx].connected = false;
        if (room.host === socket.id && room.gameState === "waiting") {
          rooms.delete(playerInfo.roomCode);
          io.to(playerInfo.roomCode).emit("room-closed", { message: "Chủ phòng đã rời, phòng đóng" });
        } else {
          if (room.gameState === "playing") room.players[pIdx].folded = true;
          io.to(playerInfo.roomCode).emit("player-disconnected", {
            playerId: socket.id,
            playerName: playerInfo.playerName,
            room,
          });
        }
      }
    }
    players.delete(socket.id);
  });
});

// ========== ERROR HANDLING & START ==========
process.on("unhandledRejection", (err) => console.error("Unhandled Rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
});

module.exports = { app, server, io };