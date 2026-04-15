document.addEventListener('DOMContentLoaded', () => {
    const board = document.getElementById('chessboard');
    const chatMessages = document.getElementById('chat-messages');

    // Chess Logic Constants
    const pieces = {
        'r': '♜', 'n': '♞', 'b': '♝', 'q': '♛', 'k': '♚', 'p': '♟',
        'R': '♜', 'N': '♞', 'B': '♝', 'Q': '♛', 'K': '♚', 'P': '♟'
    };

    // AI Difficulty Configuration
    const AI_CONFIG = {
        skillLevel: 5, // Range 0-20
        depth: 7       // Search depth
    };

    // Game Analysis Data
    let gameStateInfo = {
        evalCP: 0,
        phase: '開局',
        dangerPieces: { white: [], black: [] },
        moveCount: 0,
        halfMoveClock: 0,
        positionHistory: {} // FEN (first 4 parts) -> Count
    };

    const START_POSITION = [
        ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
        ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
        ['', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', ''],
        ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
        ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']
    ];

    let initialBoard = START_POSITION.map(row => [...row]);

    let selectedPos = null;
    let currentHints = [];
    let enPassantTarget = null;
    let movedState = {};
    let isAITurn = false;

    // AI Engine Setup (Web Worker)
    let engine;
    try {
        engine = new Worker('stockfish.js');
        engine.onmessage = (event) => {
            const line = typeof event === 'string' ? event : event.data;
            
            // Parse AI Evaluation (Centipawns)
            if (line.includes('score cp')) {
                const match = line.match(/score cp (-?\d+)/);
                if (match) {
                    gameStateInfo.evalCP = (parseInt(match[1]) / 100).toFixed(1);
                    console.log(`Current Eval: ${gameStateInfo.evalCP}`);
                }
            }

            if (line.startsWith('bestmove')) {
                const uci = line.split(' ')[1];
                if (uci && uci !== '(none)') {
                    executeAIMove(uci);
                } else {
                    // AI has no moves (Checkmate or Stalemate)
                    isAITurn = false;
                    updateGameStatusUI();
                }
            }
        };
        engine.postMessage('uci');
        engine.postMessage(`setoption name Skill Level value ${AI_CONFIG.skillLevel}`);
    } catch (e) {
        console.error("Failed to initialize Stockfish Worker:", e);
        engine = null;
    }

    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const ranks = ['8', '7', '6', '5', '4', '3', '2', '1'];
    const getCoord = (r, c) => (files[c] + ranks[r]).toUpperCase();

    // Board to FEN for AI
    function getFEN(nextColor) {
        let fenRows = [];
        for (let r = 0; r < 8; r++) {
            let row = "";
            let empty = 0;
            for (let c = 0; c < 8; c++) {
                const p = initialBoard[r][c];
                if (p) {
                    if (empty > 0) { row += empty; empty = 0; }
                    row += p;
                } else { empty++; }
            }
            if (empty > 0) row += empty;
            fenRows.push(row);
        }
        let castling = "";
        if (!movedState['7-4']) {
            if (!movedState['7-7']) castling += "K";
            if (!movedState['7-0']) castling += "Q";
        }
        if (!movedState['0-4']) {
            if (!movedState['0-7']) castling += "k";
            if (!movedState['0-0']) castling += "q";
        }
        castling = castling || "-";
        let ep = enPassantTarget ? getCoord(enPassantTarget.r, enPassantTarget.c).toLowerCase() : "-";
        return `${fenRows.join('/')} ${nextColor} ${castling} ${ep} 0 1`;
    }

    function createBoard() {
        board.innerHTML = '';
        for (let i = 0; i < 9; i++) {
            for (let j = 0; j < 9; j++) {
                const cell = document.createElement('div');
                if (j === 0 && i < 8) {
                    cell.className = 'label rank-label';
                    cell.textContent = ranks[i];
                } else if (i === 8 && j > 0) {
                    cell.className = 'label file-label';
                    cell.textContent = files[j-1];
                } else if (i < 8 && j > 0) {
                    const r = i;
                    const c = j - 1;
                    const piece = initialBoard[r][c];
                    cell.className = `cell ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
                    if (selectedPos && selectedPos.r === r && selectedPos.c === c) cell.classList.add('selected');
                    
                    const hint = currentHints.find(h => h.r === r && h.c === c);
                    if (hint) {
                        if (hint.type === 'capture' || hint.type === 'enPassant') {
                            cell.classList.add('capture-hint'); // Red border, no dot
                        } else {
                            cell.classList.add('hint'); // Blue dot
                        }
                    }
                    
                    if (piece) {
                        cell.textContent = pieces[piece];
                        cell.classList.add(piece === piece.toUpperCase() ? 'piece-w' : 'piece-b');
                    }
                    cell.addEventListener('click', () => handleCellClick(r, c));
                } else {
                    cell.className = 'label corner';
                }
                board.appendChild(cell);
            }
        }
    }

    function handleCellClick(r, c) {
        if (isAITurn) return;
        const piece = initialBoard[r][c];
        const moveTarget = currentHints.find(h => h.r === r && h.c === c);

        if (moveTarget) {
            executeMove(selectedPos.r, selectedPos.c, r, c, moveTarget);
            return;
        }

        if (selectedPos && selectedPos.r === r && selectedPos.c === c) {
            clearSelection();
            createBoard();
            return;
        }

        if (piece && piece === piece.toUpperCase()) {
            selectedPos = { r, c };
            currentHints = calculateValidMoves(r, c, piece);
            createBoard();
        } else {
            clearSelection();
            createBoard();
        }
    }

    async function executeMove(fromR, fromC, toR, toC, moveData, isAIExecution = false) {
        const fromCoord = getCoord(fromR, fromC);
        const toCoord = getCoord(toR, toC);
        let piece = initialBoard[fromR][fromC];
        let moveMsg = `${fromCoord}->${toCoord}`;
        const isWhite = piece === piece.toUpperCase();

        // Animation logic
        const sourceIdx = fromR * 9 + (fromC + 1);
        const targetIdx = toR * 9 + (toC + 1);
        const sourceEl = board.children[sourceIdx];
        const targetEl = board.children[targetIdx];

        if (sourceEl && targetEl) {
            const sourceRect = sourceEl.getBoundingClientRect();
            const targetRect = targetEl.getBoundingClientRect();

            const mover = document.createElement('div');
            mover.className = `moving-piece ${piece === piece.toUpperCase() ? 'piece-w' : 'piece-b'}`;
            mover.textContent = pieces[piece];
            mover.style.left = `${sourceRect.left}px`;
            mover.style.top = `${sourceRect.top}px`;
            mover.style.width = `${sourceRect.width}px`;
            mover.style.height = `${sourceRect.height}px`;
            document.body.appendChild(mover);

            sourceEl.classList.add('moving-hidden');

            // Force reflow
            mover.offsetHeight;

            mover.style.transform = `translate(${targetRect.left - sourceRect.left}px, ${targetRect.top - sourceRect.top}px)`;

            await new Promise(resolve => setTimeout(resolve, 400));
            document.body.removeChild(mover);
        }

        if (moveData.type === 'enPassant') {
            initialBoard[fromR][toC] = ''; 
            moveMsg += " (過路吃兵!)";
        }

        if (moveData.type === 'castle') {
            const rookFromC = toC === 6 ? 7 : 0;
            const rookToC = toC === 6 ? 5 : 3;
            initialBoard[toR][rookToC] = initialBoard[toR][rookFromC];
            initialBoard[toR][rookFromC] = '';
            moveMsg += " (王車易位!)";
        }

        if ((piece.toLowerCase() === 'p') && (toR === 0 || toR === 7)) {
            if (isAIExecution) {
                piece = isWhite ? 'Q' : 'q'; // AI defaults to Queen
            } else {
                piece = await showPromotionChoice(isWhite);
            }
            moveMsg += ` (兵之升變 -> ${pieces[piece]}!)`;
        }

        const isCapture = !!initialBoard[toR][toC];
        const isPawnMove = piece.toLowerCase() === 'p';

        if (isCapture || isPawnMove) {
            gameStateInfo.halfMoveClock = 0;
        } else {
            gameStateInfo.halfMoveClock++;
        }

        initialBoard[toR][toC] = piece;
        initialBoard[fromR][fromC] = '';
        movedState[`${fromR}-${fromC}`] = true;
        
        enPassantTarget = (piece.toLowerCase() === 'p' && Math.abs(toR - fromR) === 2) 
            ? { r: (fromR + toR) / 2, c: toC, vulnerableColor: isWhite ? 'w' : 'b' } 
            : null;

        appendMessage(isAIExecution ? 'opponent' : 'user', moveMsg);
        clearSelection();
        createBoard();
        
        // Determine game state for the player who just received the turn
        const nextColor = isAIExecution ? 'W' : 'B';
        const gameState = checkGameState(nextColor);

        if (gameState === 'CHECKMATE' || gameState === 'STALEMATE' || gameState.startsWith('DRAW')) {
            isAITurn = true; 
            updateGameStatusUI();
            
            setTimeout(() => {
                appendMessage('opponent', getHaoMeiQuote(gameState));
                appendResetButton();
            }, 800);
            return;
        }

        if (!isAIExecution) {
            isAITurn = true;
            if (engine) {
                engine.postMessage(`position fen ${getFEN('b')}`);
                engine.postMessage(`go depth ${AI_CONFIG.depth}`);
            } else {
                appendMessage('system', 'AI 引擎未載入，請手動操作黑方。');
                isAITurn = false;
            }
        } else {
            isAITurn = false;
        }

        gameStateInfo.moveCount++;
        updateAnalysis();
        
        // Record position for Repetition check
        const fenParts = getFEN(isAIExecution ? 'w' : 'b').split(' ');
        const positionKey = fenParts.slice(0, 4).join(' '); // Board + turn + castle + ep
        gameStateInfo.positionHistory[positionKey] = (gameStateInfo.positionHistory[positionKey] || 0) + 1;

        updateGameStatusUI();

        // Trigger Uncle's quote only after AI moves or when game ends
        const finalStatus = checkGameState(isAIExecution ? 'W' : 'B');
        if (isAIExecution || finalStatus !== 'NORMAL') {
            setTimeout(() => {
                appendMessage('opponent', getHaoMeiQuote(finalStatus));
            }, 800);
        }
    }


    function getHaoMeiQuote(gameState = 'NORMAL') {
        const { evalCP, phase, dangerPieces, moveCount } = gameStateInfo;
        const score = parseFloat(evalCP);
        
        // Helper to pick random from array
        const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

        // 1. Check for Game Over (Highest Priority)
        if (gameState === 'CHECKMATE') {
            const isWhiteTurn = !isAITurn; // This is the turn that JUST ended or is about to start
            if (isWhiteTurn) { // (player) won
                return pick([
                    "喔唷！這棋有鬼啦，一定是你偷換我的子... 好啦好啦，算你厲害。",
                    "今天這太陽真的太刺眼了，害我老人家失誤，這次就算你贏吧。",
                    "現在年輕人真的不得了，竟然能贏過好美里棋王，有前途喔！",
                    "哎呀，不小心被你鑽了空子。等下我要去廟裡跟土地公講一下。"
                ]);
               } else { // (uncle) won
                return pick([
                    "少年仔，回去多練練啦，好美里的水是很深的，阿伯我還沒認真呢！",
                    "將死！哈哈哈，看來今天你要請我喝兩打蘆筍露喔！",
                    "這就是經驗的差距啦，薑還是老的辣，你可以去彩繪村拍照留念散心了。",
                    "承讓承讓，這步棋我看你也是盡力了。下次再來找阿伯討教。"
                ]);
            }
        }
        if (gameState.startsWith('DRAW') || gameState === 'STALEMATE') {
            return pick([
                "平手啦！不打了不打了，我們去布袋港喝下午茶看夕陽啦。",
                "這棋下到最後大家都不吃虧，就跟我們這的鄰里關係一樣和睦。",
                "和局好啊，和氣生財，等下一起去吃鮮蚵。"
            ]);
        }

        // 2. Check for specific danger (Lower Priority: 30% chance)
        if (dangerPieces.white.length > 0 && Math.random() < 0.3) {
            return pick([
                `少年仔，你 ${dangerPieces.white[0]} 那顆棋快要被海浪捲走喔，不用救一下嗎？`,
                `欸欸欸！你的 ${dangerPieces.white[0]} 露出來了啦，我們好美里這的螃蟹都沒你這麼大方。`,
                `注意一下啦，你那個 ${dangerPieces.white[0]} 正被我盯著，像在看剛抓上岸的鮮蚵一樣。`,
                `你的 ${dangerPieces.white[0]} 沒人顧喔？等下被我吃掉不准哭喔！`
            ]);
        }

        // 2. Game Winning / Losing Excuses (Score-based)
        if (score > 3) { // AI Winning
            return pick([
                "這局我看是穩了，就像布袋的鹽田一樣，白茫茫一片（指勝局已定）。",
                "阿伯我在這走跳幾十年，這種局見多了，你再去彩繪村多逛兩圈再來。夾去配啦！",
                "少年仔，你有沒有感覺海風變強了？那是阿伯我準備收網的信號啦。",
                "我這步棋下下去，就像新塭的虱目魚一樣彈牙，你接不住的。"
            ]);
        } else if (score < -3) { // Player Winning
            return pick([
                "哎呀！這太陽太刺眼了，看得我老人家眼花，這步才讓你一下進度。",
                "剛才有隻白鷺鷥飛過去害我分心，這步不算啦... 好啦算啦算啦，讓你一點。",
                "喔唷？這步有備而來喔。是不是偷偷去跟東石的棋王請教過？",
                "現在年輕人手腳很快捏，阿伯我還在想昨天那盤蚵仔煎有沒有放太鹹。"
            ]);
        }

        // 3. Based on Phase (Opening, Mid, End)
        if (phase === '開局') {
            return pick([
                "來到好美里不先去看3D彩繪，跑來找阿伯下棋喔？開局穩一點啦！",
                "這開局下得跟我們這的蚵仔一樣肥美，後勁十足喔。",
                "慢慢來、慢慢來，好美里的生活就是這麼悠哉，不用急著衝。",
                "少年仔，這棋才剛鋪好，就像剛整理好的鹽田，要細心經營。"
            ]);
        }

        if (phase === '殘局') {
            return pick([
                "現在太陽快下山了，這局也差不多要收尾了，看阿伯我怎麼收你的軍。",
                "殘局了喔，這就像退潮後的海灘，誰有真本事一下就看出來了。",
                "嘿嘿，最後這幾顆子才是精華，就像盤底最後那顆肥美的蚵仁。",
                "別想跑！這最後的範圍比我們里長的辦公室還小，你躲不掉。"
            ]);
        }

        // 4. General Banter
        return pick([
            "這步棋... 有點意思，比我們這的老榕樹還要耐看。",
            "你要是輸了，等下要去龍宮溪幫我撈兩顆蚵仔喔！",
            "下棋要像海風一樣，快的時候很快，慢的時候要穩懂不懂？",
            "好美里沒什麼大道理，下棋跟出海一樣，看準了就不回頭。",
            "你這招... 嘖嘖，比 3D 彩繪還要花俏，華而不實喔。",
            "阿伯我今天早上剛拜過廟，運氣旺得很，你皮繃緊一點。",
            "哎呀，下到脖子有點酸，你這步走得真慢，我都快睡著了。",
            "聽說布袋港那邊最近漁獲不錯，等下下完我要去巡一下。"
        ]);
    }

    function executeAIMove(uci) {
        const fromC = files.indexOf(uci[0]);
        const fromR = ranks.indexOf(uci[1]);
        const toC = files.indexOf(uci[2]);
        const toR = ranks.indexOf(uci[3]);
        
        const piece = initialBoard[fromR][fromC];
        if (!piece) return;

        const moveData = calculateValidMoves(fromR, fromC, piece).find(m => m.r === toR && m.c === toC);
        executeMove(fromR, fromC, toR, toC, moveData || { type: 'normal' }, true);
    }

    function showPromotionChoice(isWhite) {
        return new Promise(resolve => {
            const overlay = document.getElementById('promotion-overlay');
            const options = document.querySelectorAll('.promo-option');
            overlay.style.display = 'flex';
            
            options.forEach(opt => {
                const basePiece = opt.dataset.piece;
                const actualPiece = isWhite ? basePiece : basePiece.toLowerCase();
                opt.textContent = pieces[actualPiece];
                
                const handler = () => {
                    overlay.style.display = 'none';
                    options.forEach(o => o.removeEventListener('click', handler));
                    resolve(actualPiece);
                };
                opt.addEventListener('click', handler, { once: true });
            });
        });
    }

    function clearSelection() {
        selectedPos = null;
        currentHints = [];
    }

    function calculateValidMoves(r, c, piece, boardState = initialBoard, isFiltering = true) {
        const pseudoMoves = [];
        const type = piece.toLowerCase();
        const isWhite = piece === piece.toUpperCase();

        const addMove = (nr, nc, moveType = 'normal') => {
            if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
                const target = boardState[nr][nc];
                if (!target) {
                    pseudoMoves.push({ r: nr, c: nc, type: moveType });
                    return true;
                } else if ((isWhite && target === target.toLowerCase()) || (!isWhite && target === target.toUpperCase())) {
                    pseudoMoves.push({ r: nr, c: nc, type: 'capture' });
                    return false;
                }
            }
            return false;
        };

        if (type === 'p') {
            const dir = isWhite ? -1 : 1;
            const startRow = isWhite ? 6 : 1;
            if (r + dir >= 0 && r + dir < 8 && !boardState[r + dir][c]) {
                addMove(r + dir, c);
                if (r === startRow && !boardState[r + 2 * dir][c]) addMove(r + 2 * dir, c);
            }
            [-1, 1].forEach(dc => {
                const nc = c + dc;
                if (nc >= 0 && nc < 8 && r + dir >= 0 && r + dir < 8) {
                    const target = boardState[r + dir][nc];
                    if (target && ((isWhite && target === target.toLowerCase()) || (!isWhite && target === target.toUpperCase()))) {
                        pseudoMoves.push({ r: r + dir, c: nc, type: 'capture' });
                    }
                    if (enPassantTarget && enPassantTarget.vulnerableColor !== (isWhite ? 'w' : 'b') && enPassantTarget.r === r + dir && enPassantTarget.c === nc) {
                        pseudoMoves.push({ r: r + dir, c: nc, type: 'enPassant' });
                    }
                }
            });
        } else if (type === 'n') {
            [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]].forEach(([dr, dc]) => addMove(r + dr, c + dc));
        } else if (type === 'k') {
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr !== 0 || dc !== 0) addMove(r + dr, c + dc);
            if (isFiltering && !movedState[`${r}-${c}`] && !isKingInCheck(isWhite ? 'W' : 'B')) {
                // King-side
                if (!movedState[`${r}-7`] && !boardState[r][5] && !boardState[r][6]) {
                    if (!isSquareAttacked(r, 5, isWhite ? 'b' : 'w') && !isSquareAttacked(r, 6, isWhite ? 'b' : 'w')) {
                        pseudoMoves.push({ r: r, c: 6, type: 'castle' });
                    }
                }
                // Queen-side
                if (!movedState[`${r}-0`] && !boardState[r][1] && !boardState[r][2] && !boardState[r][3]) {
                    if (!isSquareAttacked(r, 3, isWhite ? 'b' : 'w') && !isSquareAttacked(r, 2, isWhite ? 'b' : 'w')) {
                        pseudoMoves.push({ r: r, c: 2, type: 'castle' });
                    }
                }
            }
        } else if (type === 'r' || type === 'q') {
            [[0, 1], [0, -1], [1, 0], [-1, 0]].forEach(([dr, dc]) => {
                for (let i = 1; i < 8; i++) if (!addMove(r + dr * i, c + dc * i)) break;
            });
        }
        if (type === 'b' || type === 'q') {
            [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([dr, dc]) => {
                for (let i = 1; i < 8; i++) if (!addMove(r + dr * i, c + dc * i)) break;
            });
        }

        if (!isFiltering) return pseudoMoves;

        return pseudoMoves.filter(m => {
            const tempBoard = simulateMove(r, c, m.r, m.c, boardState);
            if (m.type === 'enPassant') tempBoard[r][m.c] = ''; 
            return !isKingInCheck(isWhite ? 'W' : 'B', tempBoard);
        });
    }

    function simulateMove(fromR, fromC, toR, toC, boardState) {
        const newBoard = boardState.map(row => [...row]);
        newBoard[toR][toC] = newBoard[fromR][fromC];
        newBoard[fromR][fromC] = '';
        return newBoard;
    }

    function isSquareAttacked(r, c, attackerColor, boardState = initialBoard) {
        for (let i = 0; i < 8; i++) {
            for (let j = 0; j < 8; j++) {
                const piece = boardState[i][j];
                if (piece && (attackerColor === 'w' ? piece === piece.toUpperCase() : piece === piece.toLowerCase())) {
                    // Optimized: Pawns attack differently than they move
                    if (piece.toLowerCase() === 'p') {
                        const dir = attackerColor === 'w' ? -1 : 1;
                        if (i + dir === r && (j - 1 === c || j + 1 === c)) return true;
                    } else {
                        const moves = calculateValidMoves(i, j, piece, boardState, false);
                        if (moves.some(m => m.r === r && m.c === c)) return true;
                    }
                }
            }
        }
        return false;
    }

    function isKingInCheck(color, boardState = initialBoard) {
        const kingChar = color === 'W' ? 'K' : 'k';
        const attackerColor = color === 'W' ? 'b' : 'w';
        let kingPos = null;
        for (let i = 0; i < 8; i++) {
            for (let j = 0; j < 8; j++) {
                if (boardState[i][j] === kingChar) {
                    kingPos = { r: i, c: j };
                    break;
                }
            }
            if (kingPos) break;
        }
        if (!kingPos) return false;
        return isSquareAttacked(kingPos.r, kingPos.c, attackerColor, boardState);
    }

    function checkGameState(color) {
        const isWhite = color === 'W';
        let hasLegalMoves = false;
        for (let i = 0; i < 8; i++) {
            for (let j = 0; j < 8; j++) {
                const piece = initialBoard[i][j];
                if (piece && (isWhite ? piece === piece.toUpperCase() : piece === piece.toLowerCase())) {
                    const moves = calculateValidMoves(i, j, piece, initialBoard, true);
                    if (moves.length > 0) {
                        hasLegalMoves = true;
                        break;
                    }
                }
            }
            if (hasLegalMoves) break;
        }

        const inCheck = isKingInCheck(color);
        if (!hasLegalMoves) {
            if (inCheck) return 'CHECKMATE';
            return 'STALEMATE';
        }

        // Draw by 50-move rule
        if (gameStateInfo.halfMoveClock >= 100) return 'DRAW_50';

        // Draw by Repetition
        const fenParts = getFEN(isAITurn ? 'b' : 'w').split(' ');
        const positionKey = fenParts.slice(0, 4).join(' ');
        if (gameStateInfo.positionHistory[positionKey] >= 3) return 'DRAW_REPETITION';

        // Draw by Insufficient Material
        if (isInsufficientMaterial()) return 'DRAW_MATERIAL';

        return inCheck ? 'CHECK' : 'NORMAL';
    }

    function isInsufficientMaterial() {
        const flatBoard = initialBoard.flat().filter(p => p !== '');
        if (flatBoard.length <= 2) return true; // K vs K
        if (flatBoard.length === 3) {
            const extra = flatBoard.find(p => p.toLowerCase() !== 'k');
            if (extra.toLowerCase() === 'n' || extra.toLowerCase() === 'b') return true; // K+N vs K or K+B vs K
        }
        return false;
    }

    function updateGameStatusUI() {
        // 1. Check if either side is already in a game-over state
        const whiteStatus = checkGameState('W');
        const blackStatus = checkGameState('B');
        
        const indicator = document.querySelector('.turn-indicator');
        const isWhiteTurn = !isAITurn;

        if (whiteStatus === 'CHECKMATE') {
            indicator.textContent = '將死！黑方 (阿伯) 獲勝';
            indicator.style.color = '#ef4444';
            return;
        } else if (blackStatus === 'CHECKMATE') {
            indicator.textContent = '將死！白方 (您) 獲勝';
            indicator.style.color = '#10b981';
            return;
        } else if (whiteStatus === 'STALEMATE' || blackStatus === 'STALEMATE' || whiteStatus.startsWith('DRAW') || blackStatus.startsWith('DRAW')) {
            indicator.textContent = '和局';
            indicator.style.color = '#94a3b8';
            return;
        }

        // 2. Normal turn indicator
        if (whiteStatus === 'CHECK') {
            indicator.textContent = '白方 - 將軍！';
            indicator.style.color = '#ef4444';
        } else if (blackStatus === 'CHECK') {
            indicator.textContent = '黑方 - 將軍！';
            indicator.style.color = '#ef4444';
        } else {
            indicator.textContent = isWhiteTurn ? '白方回合' : '黑方回合';
            indicator.style.color = '';
        }

        // Analysis console output
        console.table({
            "時期": gameStateInfo.phase,
            "估分": gameStateInfo.evalCP,
            "步數": gameStateInfo.moveCount,
            "我方危險": gameStateInfo.dangerPieces.white.join(', '),
            "敵方危險": gameStateInfo.dangerPieces.black.join(', ')
        });
    }

    function updateAnalysis() {
        // 1. Determine Game Phase
        let totalMaterial = 0;
        const pieceWeight = { 'p': 1, 'n': 3, 'b': 3, 'r': 5, 'q': 9, 'k': 0 };
        
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const p = initialBoard[r][c];
                if (p) totalMaterial += pieceWeight[p.toLowerCase()];
            }
        }

        if (gameStateInfo.moveCount < 12 && totalMaterial > 35) {
            gameStateInfo.phase = '開局';
        } else if (totalMaterial < 24) {
            gameStateInfo.phase = '殘局';
        } else {
            gameStateInfo.phase = '中局';
        }

        // 2. Identify Endangered Pieces (Attacked but not defended)
        gameStateInfo.dangerPieces = { white: [], black: [] };
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const piece = initialBoard[r][c];
                if (!piece) continue;

                const isWhite = piece === piece.toUpperCase();
                const attackerColor = isWhite ? 'b' : 'w';
                
                if (isSquareAttacked(r, c, attackerColor)) {
                    // Check if is defended (simulate removing this piece to see if square is still covered)
                    const isDefended = isSquareAttacked(r, c, isWhite ? 'w' : 'b', simulateRemove(r, c));
                    if (!isDefended) {
                        const coord = getCoord(r, c);
                        if (isWhite) gameStateInfo.dangerPieces.white.push(coord);
                        else gameStateInfo.dangerPieces.black.push(coord);
                    }
                }
            }
        }
    }

    function simulateRemove(r, c) {
        const newBoard = initialBoard.map(row => [...row]);
        newBoard[r][c] = '';
        return newBoard;
    }

    // Chat Logic
    function appendMessage(sender, text) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${sender}`;
        msgDiv.textContent = text;
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function appendResetButton() {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message system';
        msgDiv.innerHTML = '<div>棋局已結束。</div>';
        
        const btn = document.createElement('button');
        btn.className = 'reset-btn';
        btn.textContent = '再來一局';
        btn.addEventListener('click', resetGame);
        
        msgDiv.appendChild(btn);
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function resetGame() {
        // Reset Logic
        initialBoard = START_POSITION.map(row => [...row]);
        Object.keys(movedState).forEach(key => delete movedState[key]);
        gameStateInfo = {
            evalCP: 0,
            phase: '開局',
            dangerPieces: { white: [], black: [] },
            moveCount: 0,
            halfMoveClock: 0,
            positionHistory: {}
        };
        isAITurn = false;
        enPassantTarget = null;
        
        // UI Reset
        chatMessages.innerHTML = '';
        appendMessage('system', '新局開始。');
        setTimeout(() => {
            appendMessage('opponent', '又要挑戰阿伯我喔？來啊！必須來跟我這個棋王過一下招！');
        }, 500);
        
        createBoard();
        updateGameStatusUI();
    }

    // Initialize
    createBoard();
    updateGameStatusUI();
    
    // Initial welcome message (Hao-Mei Uncle style)
    setTimeout(() => {
        appendMessage('opponent', '少年仔，來到嘉義好美里，必須來跟我這個棋王過一下招！');
    }, 500);
});
