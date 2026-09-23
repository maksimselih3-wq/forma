<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Дневник спортсмена</title>
<link rel="stylesheet" href="style.css?v=10" />
<script src="https://telegram.org/js/telegram-web-app.js"></script>
</head>
<body>

  <header class="topbar">
    <h1>Дневник спортсмена</h1>
    <div class="topbar-actions">
      <button id="chatBtn" class="icon-btn" title="Чат с Fom">💬</button>
      <button id="insightsBtn" class="icon-btn" title="Разбор нагрузки">📊</button>
      <button id="friendsBtn" class="icon-btn" title="Друзья">👥</button>
      <button id="profileBtn" class="avatar-btn" title="Мой аккаунт">
        <img id="avatarImg" src="" alt="" style="display:none" />
        <span id="avatarFallback">👤</span>
      </button>
    </div>
  </header>

  <!-- ЭКРАН: ГЛАВНАЯ / НОВАЯ ЗАПИСЬ -->
  <main id="mainScreen">
    <div class="streak-bar">
      🔥 Серия: <span id="streakCurrent">-</span> дн. (лучшая: <span id="streakBest">-</span>)
    </div>

    <h2 id="entryTitle">Запись за сегодня</h2>

    <!-- Выбор даты: быстрые кнопки + календарь -->
    <div class="date-picker-row">
      <button type="button" class="chip" data-shift="0">Сегодня</button>
      <button type="button" class="chip" data-shift="1">Вчера</button>
      <label class="date-input-wrap">
        📅 <input type="date" id="entryDate" />
      </label>
    </div>

    <!-- Карточка «запись уже есть / сохранена» — показывается вместо формы -->
    <div id="entryDone" class="done-card hidden">
      <div class="done-title" id="doneTitle">✅ Запись сохранена</div>
      <div id="doneSummary" class="done-summary"></div>

      <div id="doneFeedbackBox" class="ai-box hidden">
        <div class="ai-box-title">🤖 Fom</div>
        <div id="doneFeedbackText"></div>
      </div>

      <button type="button" id="doneShareBtn" class="secondary-btn">📤 Поделиться</button>
      <button type="button" id="doneEditBtn" class="secondary-btn">✏️ Изменить запись</button>
      <div class="muted done-hint">Чтобы добавить запись за другой день — выбери дату выше.</div>
    </div>

    <!-- Форма новой записи -->
    <div id="entryForm">
    <div class="segmented">
      <button class="seg-btn active" data-type="training">Тренировка</button>
      <button class="seg-btn" data-type="rest">Отдых</button>
    </div>

    <div id="trainingFields">
      <label>Разминка</label>
      <textarea id="warmup" rows="2" placeholder="Например: 15 мин бег трусцой + суставная"></textarea>

      <label>Основная работа</label>
      <div id="setsList"></div>
      <button id="addSetBtn" type="button" class="secondary-btn">+ Добавить повтор</button>

      <label>Заминка</label>
      <textarea id="cooldown" rows="2" placeholder="Необязательно"></textarea>

      <div class="slider-row">
        <label>Самочувствие: <span id="feelingVal">5</span>/10</label>
        <input type="range" id="feeling" min="1" max="10" value="5" />
      </div>

      <div class="slider-row">
        <label>RPE (нагрузка): <span id="rpeVal">5</span>/10</label>
        <input type="range" id="rpe" min="1" max="10" value="5" />
      </div>
    </div>

    <label>Заметки</label>
    <textarea id="notes" rows="2" placeholder="Как прошло, что заметил..."></textarea>

    <div class="visibility-row">
      <label><input type="checkbox" id="visibility" /> Показывать друзьям (публично)</label>
    </div>

    <button id="saveBtn" class="primary-btn">Сохранить запись</button>

    <div id="statusMsg" class="status-msg"></div>
    </div>
  </main>

  <!-- ЭКРАН: ПРОФИЛЬ + КАЛЕНДАРЬ -->
  <section id="profileScreen" class="hidden">
    <button id="backBtn" class="secondary-btn">← Назад</button>
    <div class="profile-card">
      <img id="profileAvatar" src="" alt="" />
      <h2 id="profileName">-</h2>
      <p id="profileUsername" class="muted">-</p>
      <div class="profile-stats">
        <div><span id="profileStreak">-</span><br /><small>дней подряд</small></div>
        <div><span id="profileBest">-</span><br /><small>лучший рекорд</small></div>
      </div>
    </div>

    <h3>Календарь</h3>
    <div class="cal">
      <div class="cal-header">
        <button type="button" id="calPrev" class="cal-nav">‹</button>
        <span id="calTitle"></span>
        <button type="button" id="calNext" class="cal-nav">›</button>
      </div>
      <div class="cal-weekdays">
        <span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Вс</span>
      </div>
      <div id="calGrid" class="cal-grid"></div>
      <div class="cal-legend">
        <span><i class="dot dot-training"></i> тренировка</span>
        <span><i class="dot dot-rest"></i> отдых</span>
      </div>
      <div id="calSummary" class="muted cal-summary"></div>
      <div class="muted cal-help">Нажми на пустой день, чтобы добавить запись задним числом, или на отмеченный — чтобы открыть её.</div>
    </div>

    <h3>Последние записи</h3>
    <div id="historyList"></div>
  </section>

  <!-- ЭКРАН: ДРУЗЬЯ -->
  <section id="friendsScreen" class="hidden">
    <button id="friendsBackBtn" class="secondary-btn">← Назад</button>

    <h2>Добавить друга</h2>
    <div class="add-friend-row">
      <input type="text" id="friendUsernameInput" placeholder="username без @" />
      <button id="sendRequestBtn" class="primary-btn small-btn">Добавить</button>
    </div>
    <div id="friendRequestStatus" class="status-msg"></div>

    <div id="incomingRequestsBlock">
      <h3>Заявки в друзья</h3>
      <div id="incomingRequestsList"></div>
    </div>

    <h3>Мои друзья</h3>
    <div id="friendsList"></div>
  </section>

  <!-- ЭКРАН: РАЗБОР НАГРУЗКИ -->
  <section id="insightsScreen" class="hidden">
    <button id="insightsBackBtn" class="secondary-btn">← Назад</button>

    <h2>Разбор нагрузки</h2>

    <div class="segmented">
      <button class="seg-btn active" data-period="week">За неделю</button>
      <button class="seg-btn" data-period="month">За месяц</button>
    </div>

    <button id="refreshInsightBtn" class="primary-btn">Обновить разбор</button>

    <div id="insightLoading" class="status-msg hidden">Fom анализирует тренировки...</div>
    <div id="insightEmpty" class="empty-hint hidden">Пока недостаточно записей за этот период.</div>
    <div id="insightBox" class="ai-box hidden">
      <div class="ai-box-title">📊 Разбор от Fom</div>
      <div id="insightText"></div>
    </div>
  </section>

  <!-- ЭКРАН: ЧАТ С FOM -->
  <section id="chatScreen" class="hidden chat-section">
    <button id="chatBackBtn" class="secondary-btn">← Назад</button>
    <h2>Чат с Fom</h2>
    <div id="chatMessages" class="chat-messages"></div>
    <div class="chat-input-row">
      <input type="text" id="chatInput" placeholder="Спроси Fom про свои тренировки..." />
      <button id="chatSendBtn" class="primary-btn small-btn">Отправить</button>
    </div>
  </section>

  <!-- ЭКРАН: РЕДАКТИРОВАНИЕ ЗАПИСИ -->
  <section id="editScreen" class="hidden">
    <button id="editBackBtn" class="secondary-btn">← Назад</button>
    <h2>Запись за <span id="editDateLabel"></span></h2>

    <div id="editTrainingFields">
      <label>Разминка</label>
      <textarea id="editWarmup" rows="2"></textarea>

      <label>Основная работа</label>
      <div id="editSetsList"></div>
      <button id="addEditSetBtn" type="button" class="secondary-btn">+ Добавить повтор</button>

      <label>Заминка</label>
      <textarea id="editCooldown" rows="2"></textarea>

      <div class="slider-row">
        <label>Самочувствие: <span id="editFeelingVal">5</span>/10</label>
        <input type="range" id="editFeeling" min="1" max="10" value="5" />
      </div>

      <div class="slider-row">
        <label>RPE (нагрузка): <span id="editRpeVal">5</span>/10</label>
        <input type="range" id="editRpe" min="1" max="10" value="5" />
      </div>
    </div>

    <label>Заметки</label>
    <textarea id="editNotes" rows="2"></textarea>

    <div class="visibility-row">
      <label><input type="checkbox" id="editVisibility" /> Показывать друзьям (публично)</label>
    </div>

    <button id="editSaveBtn" class="primary-btn">Сохранить изменения</button>
    <button id="editShareBtn" class="secondary-btn">📤 Поделиться</button>
    <button id="editDeleteBtn" class="secondary-btn danger-btn">🗑 Удалить запись</button>

    <div id="editStatusMsg" class="status-msg"></div>
  </section>

  <script src="app.js?v=10"></script>
</body>
</html>
