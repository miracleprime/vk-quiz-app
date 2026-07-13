const socket = io();

const questionArea = document.getElementById('questionArea');
const answerResult = document.getElementById('answerResult');
const leaderboardArea = document.getElementById('leaderboardArea');

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderQuestion(question) {
  answerResult.innerHTML = '';

  const inputType = question.questionType === 'multiple' ? 'checkbox' : 'radio';

  const optionsHtml = question.options.map((option) => {
    return `
      <label class="list-group-item answer-option">
        <input class="form-check-input me-2" type="${inputType}" name="answerOption" value="${option.id}">
        ${escapeHtml(option.text)}
      </label>
    `;
  }).join('');

  const imageHtml = question.imageUrl
    ? `<img src="${escapeHtml(question.imageUrl)}" alt="Изображение к вопросу" class="img-fluid rounded mb-3 quiz-image">`
    : '';

  questionArea.innerHTML = `
    <h2 class="h4 mb-3">${escapeHtml(question.text)}</h2>
    ${imageHtml}

    <form id="answerForm">
      <div class="list-group mb-3">
        ${optionsHtml}
      </div>

      <button class="btn btn-primary w-100" type="submit">Ответить</button>
    </form>
  `;

  const answerForm = document.getElementById('answerForm');

  answerForm.addEventListener('submit', (event) => {
    event.preventDefault();

    const selectedInputs = document.querySelectorAll('input[name="answerOption"]:checked');
    const selectedOptionIds = Array.from(selectedInputs).map((input) => Number(input.value));

    socket.emit('player-submit-answer', {
      roomId: window.ROOM_ID,
      participantId: window.PARTICIPANT_ID,
      questionId: question.id,
      selectedOptionIds
    });
  });
}

function renderLeaderboard(leaderboard) {
  const html = leaderboard.map((participant, index) => {
    return `
      <li class="list-group-item d-flex justify-content-between">
        <strong>${index + 1}. ${escapeHtml(participant.name)}</strong>
        <span>${participant.score} баллов</span>
      </li>
    `;
  }).join('');

  leaderboardArea.innerHTML = `
    <h2 class="h4">Итоговый лидерборд</h2>
    <ul class="list-group">${html}</ul>
  `;
}

socket.emit('player-join-room', {
  roomId: window.ROOM_ID,
  participantId: window.PARTICIPANT_ID
});

socket.on('question-show', (question) => {
  renderQuestion(question);
});

socket.on('answer-result', (result) => {
  if (!result.success) {
    answerResult.innerHTML = `
      <div class="alert alert-warning">
        ${escapeHtml(result.message)}
      </div>
    `;
    return;
  }

  answerResult.innerHTML = `
    <div class="alert ${result.isCorrect ? 'alert-success' : 'alert-danger'}">
      ${escapeHtml(result.message)}
    </div>
  `;

  const answerForm = document.getElementById('answerForm');

  if (answerForm) {
    answerForm.querySelectorAll('input, button').forEach((element) => {
      element.disabled = true;
    });
  }
});

socket.on('quiz-finished', (leaderboard) => {
  questionArea.innerHTML = `
    <div class="alert alert-success">
      Квиз завершён. Результаты ниже.
    </div>
  `;

  answerResult.innerHTML = '';
  renderLeaderboard(leaderboard);
});