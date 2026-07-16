const socket = io();

const nextQuestionBtn = document.getElementById('nextQuestionBtn');
const finishQuizBtn = document.getElementById('finishQuizBtn');
const currentQuestionHost = document.getElementById('currentQuestionHost');
const leaderboardHost = document.getElementById('leaderboardHost');

let hostTimerInterval = null;

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function startHostTimer(endsAt) {
  const timerElement = document.getElementById('hostTimer');

  if (!timerElement || !endsAt) {
    return;
  }

  if (hostTimerInterval) {
    clearInterval(hostTimerInterval);
  }

  function updateTimer() {
    const secondsLeft = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    timerElement.textContent = secondsLeft;

    if (secondsLeft <= 0) {
      clearInterval(hostTimerInterval);
      hostTimerInterval = null;
    }
  }

  updateTimer();
  hostTimerInterval = setInterval(updateTimer, 1000);
}

function renderParticipants(participants) {
  const participantsList = document.getElementById('participantsList');

  if (!participantsList) {
    return;
  }

  if (participants.length === 0) {
    participantsList.innerHTML = `
      <div class="alert alert-info mb-0">
        Пока никто не подключился.
      </div>
    `;
    return;
  }

  const html = participants.map((participant, index) => {
    return `
      <li class="list-group-item d-flex justify-content-between">
        <span>${index + 1}. ${escapeHtml(participant.name)}</span>
        <span>${participant.score} баллов</span>
      </li>
    `;
  }).join('');

  participantsList.innerHTML = `<ul class="list-group">${html}</ul>`;
}

function renderLeaderboard(leaderboard) {
  if (!leaderboardHost) {
    return;
  }

  const html = leaderboard.map((participant, index) => {
    return `
      <li class="list-group-item d-flex justify-content-between">
        <strong>${index + 1}. ${escapeHtml(participant.name)}</strong>
        <span>${participant.score} баллов</span>
      </li>
    `;
  }).join('');

leaderboardHost.innerHTML = `
  <h3 class="h4">Итоговый лидерборд</h3>
  <ul class="list-group mb-3">${html}</ul>
  <a href="/rooms/${window.ROOM_ID}/results" class="btn btn-outline-success">
    Открыть страницу результатов
  </a>
`;
}

socket.emit('host-join-room', {
  roomId: window.ROOM_ID
});

nextQuestionBtn.addEventListener('click', () => {
  socket.emit('host-next-question', {
    roomId: window.ROOM_ID
  });
});

finishQuizBtn.addEventListener('click', () => {
  socket.emit('host-finish-quiz', {
    roomId: window.ROOM_ID
  });
});

socket.on('participants-updated', (participants) => {
  renderParticipants(participants);
});

socket.on('question-show', (question) => {
  if (!currentQuestionHost) {
    return;
  }

  currentQuestionHost.innerHTML = `
    <p class="mb-2"><strong>${escapeHtml(question.text)}</strong></p>
    <p class="text-muted mb-2">
      Тип вопроса: ${question.questionType === 'multiple' ? 'множественный выбор' : 'одиночный выбор'}
    </p>
    <div class="timer-box">
      Осталось времени: <strong><span id="hostTimer">0</span> сек.</strong>
    </div>
  `;

  startHostTimer(question.endsAt);
});

socket.on('question-closed', () => {
  if (currentQuestionHost) {
    currentQuestionHost.innerHTML += `
      <div class="alert alert-warning mt-3 mb-0">
        Время на вопрос вышло. Можно запускать следующий вопрос.
      </div>
    `;
  }
});

socket.on('quiz-finished', (leaderboard) => {
  if (hostTimerInterval) {
    clearInterval(hostTimerInterval);
  }

  if (currentQuestionHost) {
    currentQuestionHost.innerHTML = `
      <div class="alert alert-success mb-0">
        Квиз завершён.
      </div>
    `;
  }

  nextQuestionBtn.disabled = true;
  finishQuizBtn.disabled = true;

  renderLeaderboard(leaderboard);
});