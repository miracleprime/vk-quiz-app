const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const { initDb, run, get, all } = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const roomTimers = new Map();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'vk-quiz-secret-key',
  resave: false,
  saveUninitialized: false
}));

function hashPassword(password, salt) {
  return crypto
    .pbkdf2Sync(password, salt, 10000, 64, 'sha512')
    .toString('hex');
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

async function getQuestionPayload(questionId) {
  const question = await get(
    'SELECT * FROM questions WHERE id = ?',
    [questionId]
  );

  if (!question) {
    return null;
  }

  const options = await all(
    'SELECT id, text FROM answer_options WHERE question_id = ? ORDER BY id ASC',
    [questionId]
  );

  return {
    id: question.id,
    text: question.text,
    imageUrl: question.image_url,
    questionType: question.question_type,
    options
  };
}

async function getLeaderboard(roomId) {
  return await all(
    'SELECT name, score FROM participants WHERE room_id = ? ORDER BY score DESC, joined_at ASC',
    [roomId]
  );
}

async function getNextQuestion(roomId) {
  const room = await get(
    'SELECT * FROM rooms WHERE id = ?',
    [roomId]
  );

  if (!room) {
    return null;
  }

  const questions = await all(
    `
    SELECT questions.*
    FROM questions
    JOIN rooms ON questions.quiz_id = rooms.quiz_id
    WHERE rooms.id = ?
    ORDER BY questions.position ASC, questions.id ASC
    `,
    [roomId]
  );

  if (questions.length === 0) {
    return null;
  }

  if (!room.current_question_id) {
    return questions[0];
  }

  const currentIndex = questions.findIndex(
    (question) => question.id === room.current_question_id
  );

  if (currentIndex === -1 || currentIndex + 1 >= questions.length) {
    return null;
  }

  return questions[currentIndex + 1];
}

async function checkAnswer(questionId, selectedOptionIds) {
  const correctOptions = await all(
    'SELECT id FROM answer_options WHERE question_id = ? AND is_correct = 1 ORDER BY id ASC',
    [questionId]
  );

  const correctIds = correctOptions.map((option) => Number(option.id)).sort();
  const selectedIds = selectedOptionIds.map((id) => Number(id)).sort();

  if (correctIds.length !== selectedIds.length) {
    return false;
  }

  return correctIds.every((id, index) => id === selectedIds[index]);
}

function clearRoomTimer(roomId) {
  const key = String(roomId);
  const timerData = roomTimers.get(key);

  if (timerData) {
    clearTimeout(timerData.timeout);
    roomTimers.delete(key);
  }
}

async function startRoomTimer(roomId, timeLimitSeconds) {
  const key = String(roomId);
  const endsAt = Date.now() + timeLimitSeconds * 1000;

  clearRoomTimer(roomId);

  const timeout = setTimeout(async () => {
    await run(
      'UPDATE rooms SET status = ? WHERE id = ?',
      ['waiting', roomId]
    );

    roomTimers.delete(key);

    io.to(`room-${roomId}`).emit('question-closed', {
      message: 'Время вышло'
    });
  }, timeLimitSeconds * 1000);

  roomTimers.set(key, {
    timeout,
    endsAt
  });

  return endsAt;
}

function getRoomTimer(roomId) {
  return roomTimers.get(String(roomId));
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }

  next();
}

app.get('/', (req, res) => {
  res.render('index', {
    user: req.session.user
  });
});

app.get('/register', (req, res) => {
  res.render('register', {
    error: null
  });
});

app.post('/register', async (req, res) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      return res.render('register', {
        error: 'Заполните логин и пароль'
      });
    }

    const existingUser = await get(
      'SELECT * FROM users WHERE username = ?',
      [username]
    );

    if (existingUser) {
      return res.render('register', {
        error: 'Пользователь с таким логином уже существует'
      });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);

    await run(
      'INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)',
      [username, passwordHash, salt, role || 'organizer']
    );

    res.redirect('/login');
  } catch (error) {
    console.error(error);
    res.render('register', {
      error: 'Ошибка при регистрации'
    });
  }
});

app.get('/login', (req, res) => {
  res.render('login', {
    error: null
  });
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await get(
      'SELECT * FROM users WHERE username = ?',
      [username]
    );

    if (!user) {
      return res.render('login', {
        error: 'Неверный логин или пароль'
      });
    }

    const passwordHash = hashPassword(password, user.salt);

    if (passwordHash !== user.password_hash) {
      return res.render('login', {
        error: 'Неверный логин или пароль'
      });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role
    };

    res.redirect('/dashboard');
  } catch (error) {
    console.error(error);
    res.render('login', {
      error: 'Ошибка при входе'
    });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/dashboard', requireAuth, async (req, res) => {
  const quizzes = await all(
    'SELECT * FROM quizzes WHERE user_id = ? ORDER BY created_at DESC',
    [req.session.user.id]
  );

  const rooms = await all(
    `
    SELECT 
      rooms.id,
      rooms.code,
      rooms.status,
      rooms.created_at,
      rooms.finished_at,
      quizzes.title,
      quizzes.category,
      COUNT(participants.id) as participant_count
    FROM rooms
    JOIN quizzes ON rooms.quiz_id = quizzes.id
    LEFT JOIN participants ON participants.room_id = rooms.id
    WHERE quizzes.user_id = ?
    GROUP BY rooms.id
    ORDER BY rooms.created_at DESC
    `,
    [req.session.user.id]
  );

  res.render('dashboard', {
    user: req.session.user,
    quizzes,
    rooms
  });
});

app.get('/quizzes/new', requireAuth, (req, res) => {
  res.render('quiz-new', {
    user: req.session.user,
    error: null
  });
});

app.get('/quizzes/:id/start', requireAuth, async (req, res) => {
  try {
    const quizId = req.params.id;

    const quiz = await get(
      'SELECT * FROM quizzes WHERE id = ? AND user_id = ?',
      [quizId, req.session.user.id]
    );

    if (!quiz) {
      return res.redirect('/dashboard');
    }

    const questionCount = await get(
      'SELECT COUNT(*) as count FROM questions WHERE quiz_id = ?',
      [quizId]
    );

    if (questionCount.count === 0) {
      return res.redirect(`/quizzes/${quizId}/edit`);
    }

    let code = generateRoomCode();

    while (await get('SELECT * FROM rooms WHERE code = ?', [code])) {
      code = generateRoomCode();
    }

    const roomResult = await run(
      `
      INSERT INTO rooms (quiz_id, code, status)
      VALUES (?, ?, ?)
      `,
      [quizId, code, 'waiting']
    );

    res.redirect(`/rooms/${roomResult.lastID}/host`);
  } catch (error) {
    console.error(error);
    res.redirect('/dashboard');
  }
});

app.get('/rooms/:id/host', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.id;

    const room = await get(
      `
      SELECT rooms.*, quizzes.title, quizzes.category, quizzes.time_limit, quizzes.rules, quizzes.user_id
      FROM rooms
      JOIN quizzes ON rooms.quiz_id = quizzes.id
      WHERE rooms.id = ?
      `,
      [roomId]
    );

    if (!room || room.user_id !== req.session.user.id) {
      return res.redirect('/dashboard');
    }

    const participants = await all(
      'SELECT * FROM participants WHERE room_id = ? ORDER BY score DESC, joined_at ASC',
      [roomId]
    );

    res.render('room-host', {
      user: req.session.user,
      room,
      participants
    });
  } catch (error) {
    console.error(error);
    res.redirect('/dashboard');
  }
});

app.get('/rooms/:id/results', requireAuth, async (req, res) => {
  try {
    const roomId = req.params.id;

    const room = await get(
      `
      SELECT 
        rooms.*,
        quizzes.title,
        quizzes.category,
        quizzes.time_limit,
        quizzes.rules,
        quizzes.user_id
      FROM rooms
      JOIN quizzes ON rooms.quiz_id = quizzes.id
      WHERE rooms.id = ?
      `,
      [roomId]
    );

    if (!room || room.user_id !== req.session.user.id) {
      return res.redirect('/dashboard');
    }

    const leaderboard = await all(
      `
      SELECT 
        participants.id,
        participants.name,
        participants.score,
        participants.joined_at,
        COUNT(DISTINCT answers.question_id) as answer_count
      FROM participants
      LEFT JOIN answers ON answers.participant_id = participants.id
      WHERE participants.room_id = ?
      GROUP BY participants.id
      ORDER BY participants.score DESC, participants.joined_at ASC
      `,
      [roomId]
    );

    res.render('room-results', {
      user: req.session.user,
      room,
      leaderboard
    });
  } catch (error) {
    console.error(error);
    res.redirect('/dashboard');
  }
});

app.get('/join', (req, res) => {
  res.render('join', {
    error: null
  });
});

app.post('/join', async (req, res) => {
  try {
    const { name, code } = req.body;

    if (!name || !code) {
      return res.render('join', {
        error: 'Введите имя и код комнаты'
      });
    }

    const room = await get(
      `
      SELECT rooms.*, quizzes.title
      FROM rooms
      JOIN quizzes ON rooms.quiz_id = quizzes.id
      WHERE rooms.code = ?
      `,
      [code.trim().toUpperCase()]
    );

    if (!room) {
      return res.render('join', {
        error: 'Комната с таким кодом не найдена'
      });
    }

    if (room.status === 'finished') {
      return res.render('join', {
        error: 'Этот квиз уже завершён'
      });
    }

    const participantResult = await run(
      `
      INSERT INTO participants (room_id, name, score)
      VALUES (?, ?, ?)
      `,
      [room.id, name.trim(), 0]
    );

    res.redirect(`/rooms/${room.id}/player?participantId=${participantResult.lastID}`);
  } catch (error) {
    console.error(error);
    res.render('join', {
      error: 'Ошибка подключения к комнате'
    });
  }
});

app.get('/rooms/:id/player', async (req, res) => {
  try {
    const roomId = req.params.id;
    const participantId = req.query.participantId;

    const room = await get(
      `
      SELECT rooms.*, quizzes.title, quizzes.category, quizzes.time_limit, quizzes.rules
      FROM rooms
      JOIN quizzes ON rooms.quiz_id = quizzes.id
      WHERE rooms.id = ?
      `,
      [roomId]
    );

    const participant = await get(
      'SELECT * FROM participants WHERE id = ? AND room_id = ?',
      [participantId, roomId]
    );

    if (!room || !participant) {
      return res.redirect('/join');
    }

    res.render('room-player', {
      room,
      participant
    });
  } catch (error) {
    console.error(error);
    res.redirect('/join');
  }
});

io.on('connection', (socket) => {
  console.log('Пользователь подключился:', socket.id);

  socket.on('host-join-room', async ({ roomId }) => {
    socket.join(`room-${roomId}`);

    const participants = await all(
      'SELECT * FROM participants WHERE room_id = ? ORDER BY score DESC, joined_at ASC',
      [roomId]
    );

    io.to(`room-${roomId}`).emit('participants-updated', participants);

    const room = await get(
      'SELECT * FROM rooms WHERE id = ?',
      [roomId]
    );

    if (room && room.current_question_id && room.status === 'active') {
      const questionPayload = await getQuestionPayload(room.current_question_id);
      const timerData = getRoomTimer(roomId);

      socket.emit('question-show', {
        ...questionPayload,
        endsAt: timerData ? timerData.endsAt : null
      });
    }
  });

  socket.on('player-join-room', async ({ roomId, participantId }) => {
    socket.join(`room-${roomId}`);

    const participant = await get(
      'SELECT * FROM participants WHERE id = ? AND room_id = ?',
      [participantId, roomId]
    );

    if (!participant) {
      return;
    }

    const participants = await all(
      'SELECT * FROM participants WHERE room_id = ? ORDER BY score DESC, joined_at ASC',
      [roomId]
    );

    io.to(`room-${roomId}`).emit('participants-updated', participants);

    const room = await get(
      'SELECT * FROM rooms WHERE id = ?',
      [roomId]
    );

    if (room && room.current_question_id && room.status === 'active') {
      const questionPayload = await getQuestionPayload(room.current_question_id);
      const timerData = getRoomTimer(roomId);

      socket.emit('question-show', {
        ...questionPayload,
        endsAt: timerData ? timerData.endsAt : null
      });
    }
  });

  socket.on('host-next-question', async ({ roomId }) => {
    clearRoomTimer(roomId);

    const nextQuestion = await getNextQuestion(roomId);

    if (!nextQuestion) {
      await run(
        'UPDATE rooms SET status = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['finished', roomId]
      );

      const leaderboard = await getLeaderboard(roomId);

      io.to(`room-${roomId}`).emit('quiz-finished', leaderboard);
      return;
    }

    const roomWithQuiz = await get(
      `
      SELECT rooms.*, quizzes.time_limit
      FROM rooms
      JOIN quizzes ON rooms.quiz_id = quizzes.id
      WHERE rooms.id = ?
      `,
      [roomId]
    );

    const timeLimit = Number(roomWithQuiz.time_limit) || 30;

    await run(
      'UPDATE rooms SET status = ?, current_question_id = ? WHERE id = ?',
      ['active', nextQuestion.id, roomId]
    );

    const endsAt = await startRoomTimer(roomId, timeLimit);
    const questionPayload = await getQuestionPayload(nextQuestion.id);

    io.to(`room-${roomId}`).emit('question-show', {
      ...questionPayload,
      timeLimit,
      endsAt
    });
  });

  socket.on('player-submit-answer', async ({ roomId, participantId, questionId, selectedOptionIds }) => {
    try {
      if (!Array.isArray(selectedOptionIds) || selectedOptionIds.length === 0) {
        socket.emit('answer-result', {
          success: false,
          message: 'Выберите вариант ответа'
        });
        return;
      }

      const room = await get(
        'SELECT * FROM rooms WHERE id = ?',
        [roomId]
      );

      if (!room || room.status !== 'active' || room.current_question_id !== Number(questionId)) {
        socket.emit('answer-result', {
          success: false,
          message: 'Ответ сейчас недоступен'
        });
        return;
      }

      const participant = await get(
        'SELECT * FROM participants WHERE id = ? AND room_id = ?',
        [participantId, roomId]
      );

      if (!participant) {
        socket.emit('answer-result', {
          success: false,
          message: 'Участник не найден'
        });
        return;
      }

      const existingAnswer = await get(
        `
        SELECT * FROM answers
        WHERE room_id = ? AND participant_id = ? AND question_id = ?
        LIMIT 1
        `,
        [roomId, participantId, questionId]
      );

      if (existingAnswer) {
        socket.emit('answer-result', {
          success: false,
          message: 'Вы уже ответили на этот вопрос'
        });
        return;
      }

      const isCorrect = await checkAnswer(questionId, selectedOptionIds);

      for (const optionId of selectedOptionIds) {
        await run(
          `
          INSERT INTO answers (room_id, participant_id, question_id, option_id, is_correct)
          VALUES (?, ?, ?, ?, ?)
          `,
          [roomId, participantId, questionId, optionId, isCorrect ? 1 : 0]
        );
      }

      if (isCorrect) {
        await run(
          'UPDATE participants SET score = score + 1 WHERE id = ?',
          [participantId]
        );
      }

      socket.emit('answer-result', {
        success: true,
        isCorrect,
        message: isCorrect ? 'Правильно! +1 балл' : 'Неправильно'
      });

      const participants = await all(
        'SELECT * FROM participants WHERE room_id = ? ORDER BY score DESC, joined_at ASC',
        [roomId]
      );

      io.to(`room-${roomId}`).emit('participants-updated', participants);
    } catch (error) {
      console.error(error);

      socket.emit('answer-result', {
        success: false,
        message: 'Ошибка при отправке ответа'
      });
    }
  });

  socket.on('host-finish-quiz', async ({ roomId }) => {
    clearRoomTimer(roomId);

    await run(
      'UPDATE rooms SET status = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['finished', roomId]
    );

    const leaderboard = await getLeaderboard(roomId);

    io.to(`room-${roomId}`).emit('quiz-finished', leaderboard);
  });

  socket.on('disconnect', () => {
    console.log('Пользователь отключился:', socket.id);
  });
});

app.post('/quizzes', requireAuth, async (req, res) => {
  try {
    const { title, category, time_limit, rules } = req.body;

    if (!title) {
      return res.render('quiz-new', {
        user: req.session.user,
        error: 'Введите название квиза'
      });
    }

    const result = await run(
      `
      INSERT INTO quizzes (user_id, title, category, time_limit, rules)
      VALUES (?, ?, ?, ?, ?)
      `,
      [
        req.session.user.id,
        title,
        category || '',
        Number(time_limit) || 30,
        rules || ''
      ]
    );

    res.redirect(`/quizzes/${result.lastID}/edit`);
  } catch (error) {
    console.error(error);
    res.render('quiz-new', {
      user: req.session.user,
      error: 'Ошибка при создании квиза'
    });
  }
});

app.get('/quizzes/:id/edit', requireAuth, async (req, res) => {
  try {
    const quizId = req.params.id;

    const quiz = await get(
      'SELECT * FROM quizzes WHERE id = ? AND user_id = ?',
      [quizId, req.session.user.id]
    );

    if (!quiz) {
      return res.redirect('/dashboard');
    }

    const questions = await all(
      'SELECT * FROM questions WHERE quiz_id = ? ORDER BY position ASC, id ASC',
      [quizId]
    );

    const options = await all(
      `
      SELECT answer_options.*
      FROM answer_options
      JOIN questions ON answer_options.question_id = questions.id
      WHERE questions.quiz_id = ?
      ORDER BY answer_options.id ASC
      `,
      [quizId]
    );

    const questionsWithOptions = questions.map((question) => {
      return {
        ...question,
        options: options.filter((option) => option.question_id === question.id)
      };
    });

    res.render('quiz-edit', {
      user: req.session.user,
      quiz,
      questions: questionsWithOptions,
      error: null
    });
  } catch (error) {
    console.error(error);
    res.redirect('/dashboard');
  }
});

app.post('/quizzes/:id/questions', requireAuth, async (req, res) => {
  try {
    const quizId = req.params.id;

    const quiz = await get(
      'SELECT * FROM quizzes WHERE id = ? AND user_id = ?',
      [quizId, req.session.user.id]
    );

    if (!quiz) {
      return res.redirect('/dashboard');
    }

    const {
      text,
      image_url,
      question_type,
      option_1,
      option_2,
      option_3,
      option_4
    } = req.body;

    let correctOptions = req.body.correct_options || [];

    if (!Array.isArray(correctOptions)) {
      correctOptions = [correctOptions];
    }

    if ((question_type || 'single') === 'single' && correctOptions.length > 1) {
    correctOptions = [correctOptions[0]];
    }

    const optionTexts = [option_1, option_2, option_3, option_4]
      .map((option) => option ? option.trim() : '')
      .filter((option) => option.length > 0);

    if (!text || optionTexts.length < 2 || correctOptions.length === 0) {
      return res.redirect(`/quizzes/${quizId}/edit`);
    }

    const countRow = await get(
      'SELECT COUNT(*) as count FROM questions WHERE quiz_id = ?',
      [quizId]
    );

    const questionResult = await run(
      `
      INSERT INTO questions (quiz_id, text, image_url, question_type, position)
      VALUES (?, ?, ?, ?, ?)
      `,
      [
        quizId,
        text,
        image_url || '',
        question_type || 'single',
        countRow.count + 1
      ]
    );

    const questionId = questionResult.lastID;

    for (let i = 0; i < optionTexts.length; i++) {
      const optionNumber = String(i + 1);
      const isCorrect = correctOptions.includes(optionNumber) ? 1 : 0;

      await run(
        `
        INSERT INTO answer_options (question_id, text, is_correct)
        VALUES (?, ?, ?)
        `,
        [questionId, optionTexts[i], isCorrect]
      );
    }

    res.redirect(`/quizzes/${quizId}/edit`);
  } catch (error) {
    console.error(error);
    res.redirect(`/quizzes/${req.params.id}/edit`);
  }
});

app.post('/quizzes/:quizId/questions/:questionId/delete', requireAuth, async (req, res) => {
  try {
    const { quizId, questionId } = req.params;

    const quiz = await get(
      'SELECT * FROM quizzes WHERE id = ? AND user_id = ?',
      [quizId, req.session.user.id]
    );

    if (!quiz) {
      return res.redirect('/dashboard');
    }

    await run(
      'DELETE FROM answer_options WHERE question_id = ?',
      [questionId]
    );

    await run(
      'DELETE FROM questions WHERE id = ? AND quiz_id = ?',
      [questionId, quizId]
    );

    res.redirect(`/quizzes/${quizId}/edit`);
  } catch (error) {
    console.error(error);
    res.redirect(`/quizzes/${req.params.quizId}/edit`);
  }
});

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Сервер запущен: http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Ошибка запуска приложения:', error);
  });