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

  res.render('dashboard', {
    user: req.session.user,
    quizzes
  });
});

io.on('connection', (socket) => {
  console.log('Пользователь подключился:', socket.id);

  socket.on('disconnect', () => {
    console.log('Пользователь отключился:', socket.id);
  });
});

app.get('/quizzes/new', requireAuth, (req, res) => {
  res.render('quiz-new', {
    user: req.session.user,
    error: null
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