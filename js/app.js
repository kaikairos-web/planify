/* ============================================================
   PLANIFY  FULL SCHEDULING CALENDAR APP
   Single-file, offline-first, fully CRUD with alarm system
   ============================================================ */

// ============================================================
// STORAGE MODULE
// ============================================================
const Storage = (() => {
  const KEY_EVENTS = 'planify_events';
  const KEY_SETTINGS = 'planify_settings';

  function getEvents() {
    try { return JSON.parse(localStorage.getItem(KEY_EVENTS) || '[]'); }
    catch(e) { return []; }
  }

  function saveEvents(events) {
    localStorage.setItem(KEY_EVENTS, JSON.stringify(events));
  }

  function getSettings() {
    const defaults = { notif: true, vibrate: true, sound: 'bell', timeformat: '12', weekstart: '0' };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY_SETTINGS) || '{}');
      return { ...defaults, ...saved };
    } catch(e) { return defaults; }
  }

  function saveSettings(settings) {
    try { localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings)); } catch(e) {}
  }

  function exportData() {
    const data = { events: getEvents(), settings: getSettings(), exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `planify_backup_${Date.now()}.json`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  function importData(jsonStr) {
    const data = JSON.parse(jsonStr);
    if (!data || typeof data !== 'object') throw new Error('Invalid format');
    if (data.events && Array.isArray(data.events)) {
      const valid = data.events.filter(e => e.id && e.title && e.date);
      saveEvents(valid);
    }
    if (data.settings && typeof data.settings === 'object') saveSettings(data.settings);
    return data;
  }

  function clearAll() {
    try { localStorage.removeItem(KEY_EVENTS); } catch(e) {}
    try { localStorage.removeItem(KEY_SETTINGS); } catch(e) {}
  }

  return { getEvents, saveEvents, getSettings, saveSettings, exportData, importData, clearAll };
})();

// ============================================================
// EVENT MODEL MODULE
// ============================================================
const EventModel = (() => {
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function create(data) {
    const events = Storage.getEvents();
    const event = {
      id: generateId(),
      title: data.title || 'Untitled',
      description: data.description || '',
      date: data.date,
      startTime: data.startTime || '',
      endTime: data.endTime || '',
      category: data.category || 'Event',
      alarm: !!data.alarm,
      reminderBefore: parseInt(data.reminderBefore) || 0,
      repeat: data.repeat || 'none',
      done: false,
      createdAt: new Date().toISOString()
    };
    events.push(event);
    Storage.saveEvents(events);
    return event;
  }

  function update(id, data) {
    const events = Storage.getEvents();
    const idx = events.findIndex(e => e.id === id);
    if (idx === -1) return null;
    events[idx] = { ...events[idx], ...data, id };
    Storage.saveEvents(events);
    return events[idx];
  }

  function remove(id) {
    const events = Storage.getEvents().filter(e => e.id !== id);
    Storage.saveEvents(events);
  }

  function getAll() { return Storage.getEvents(); }

  function getByDate(dateStr) {
    const all = Storage.getEvents();
    const d = new Date(dateStr + 'T00:00:00');
    return all.filter(e => {
      if (e.date === dateStr) return true;
      // Check repeating
      const eDate = new Date(e.date + 'T00:00:00');
      if (e.repeat === 'daily') return true;
      if (e.repeat === 'weekly') return d.getDay() === eDate.getDay();
      if (e.repeat === 'yearly') return d.getMonth() === eDate.getMonth() && d.getDate() === eDate.getDate();
      return false;
    });
  }

  function getForMonth(year, month) {
    // Returns a map of dateStr -> events[]
    const all = Storage.getEvents();
    const map = {};
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dayDate = new Date(dateStr + 'T00:00:00');
      const dayEvents = all.filter(e => {
        if (e.date === dateStr) return true;
        const eDate = new Date(e.date + 'T00:00:00');
        if (e.repeat === 'daily') return true;
        if (e.repeat === 'weekly') return dayDate.getDay() === eDate.getDay();
        if (e.repeat === 'yearly') return dayDate.getMonth() === eDate.getMonth() && dayDate.getDate() === eDate.getDate();
        return false;
      });
      if (dayEvents.length) map[dateStr] = dayEvents;
    }
    return map;
  }

  function getToday() {
    return getByDate(getTodayStr());
  }

  function getUpcoming(limit = 10) {
    const today = getTodayStr();
    const todayDate = new Date(today + 'T00:00:00');
    const all = Storage.getEvents();
    // Include future one-time events + active repeat events
    const upcoming = all.filter(e => {
      if (e.done) return false;
      if (e.repeat !== 'none') return true; // repeating always upcoming
      return e.date > today;
    });
    return upcoming
      .sort((a,b) => a.date.localeCompare(b.date) || (a.startTime||'').localeCompare(b.startTime||''))
      .slice(0, limit);
  }

  function getTodayStr() {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
  }

  return { create, update, remove, getAll, getByDate, getForMonth, getToday, getUpcoming, getTodayStr };
})();

// ============================================================
// ALARM MODULE
// ============================================================
const AlarmModule = (() => {
  let timers = {};
  let audioCtx = null;

  // Resume AudioContext on first user gesture (fixes autoplay block)
  function unlockAudio() {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }
  document.addEventListener('click', unlockAudio, { once: false });
  document.addEventListener('touchstart', unlockAudio, { once: false });

  function getAudioCtx() {
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch(e) {}
    }
    return audioCtx;
  }

  function playSound() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const settings = Storage.getSettings();
    if (settings.sound === 'none') return;

    const sound = settings.sound || 'bell';

    // Play 3 beeps in sequence for better audibility
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.4;

      if (sound === 'bell') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, t);
        osc.frequency.exponentialRampToValueAtTime(440, t + 0.3);
        gain.gain.setValueAtTime(0.4, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        osc.start(t); osc.stop(t + 0.3);
      } else if (sound === 'chime') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1047, t);
        gain.gain.setValueAtTime(0.3, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        osc.start(t); osc.stop(t + 0.35);
      } else {
        osc.type = 'square';
        osc.frequency.setValueAtTime(520, t);
        gain.gain.setValueAtTime(0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        osc.start(t); osc.stop(t + 0.15);
      }
    }

    if (settings.vibrate && navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);
  }

  function sendNotification(title, body) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body, icon: '' });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(p => {
        if (p === 'granted') new Notification(title, { body, icon: '' });
      });
    }
  }

  function scheduleAlarm(event) {
    const settings = Storage.getSettings();
    if (!settings.notif || !event.alarm || !event.startTime) return;
    if (timers[event.id]) clearTimeout(timers[event.id]);

    const now = new Date();
    const target = new Date(event.date + 'T' + event.startTime + ':00');
    const triggerTime = new Date(target.getTime() - (event.reminderBefore || 0) * 60000);
    const ms = triggerTime - now;

    if (ms > 0 && ms < 86400000) {
      timers[event.id] = setTimeout(() => fireAlarm(event), ms);
    }
  }

  function fireAlarm(event) {
    playSound();
    const msg = event.reminderBefore > 0
      ? `In ${event.reminderBefore} min: ${event.startTime}`
      : `Now: ${event.startTime}`;
    ToastModule.show(`Alarm: ${event.title}`, msg, 'alarm', 10000);
    sendNotification(`Alarm: ${event.title}`, msg);
  }

  function scheduleAll() {
    const events = EventModel.getAll();
    const today = EventModel.getTodayStr();
    events.forEach(e => {
      if (!e.done && (e.date === today || e.repeat !== 'none')) scheduleAlarm(e);
    });
  }

  function cancelAlarm(id) {
    if (timers[id]) { clearTimeout(timers[id]); delete timers[id]; }
  }

  function cancelAll() {
    Object.values(timers).forEach(clearTimeout);
    timers = {};
  }

  // Request notification permission proactively on first interaction
  function requestPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  return { scheduleAll, scheduleAlarm, cancelAlarm, cancelAll, playSound, requestPermission };
})();
// TOAST MODULE
// ============================================================
const ToastModule = (() => {
  function show(msg, sub, type = 'default', duration = 3000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${type === 'alarm' ? '[!]' : type === 'success' ? '[ok]' : type === 'error' ? '[x]' : '[i]'}</span>
      <div class="toast-msg">${msg}${sub ? `<br><small style="color:var(--text-muted)">${sub}</small>` : ''}</div>
      <span class="toast-close" onclick="this.parentElement.remove()">&#10005;</span>
    `;
    container.appendChild(toast);
    if (duration > 0) setTimeout(() => toast.remove(), duration);
    return toast;
  }
  return { show };
})();

// ============================================================
// CALENDAR UI MODULE
// ============================================================
const CalendarUI = (() => {
  let currentYear, currentMonth, selectedDate;

  function init() {
    const now = new Date();
    currentYear = now.getFullYear();
    currentMonth = now.getMonth();
    selectedDate = EventModel.getTodayStr();
    renderWeekdays();
    render();
    selectDate(selectedDate);
    document.getElementById('cal-prev').addEventListener('click', prevMonth);
    document.getElementById('cal-next').addEventListener('click', nextMonth);
    document.getElementById('btn-today-jump').addEventListener('click', goToday);
  }

  function renderWeekdays() {
    const settings = Storage.getSettings();
    const start = parseInt(settings.weekstart);
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const ordered = [...days.slice(start), ...days.slice(0, start)];
    document.getElementById('cal-weekdays').innerHTML =
      ordered.map(d => `<div class="cal-weekday">${d}</div>`).join('');
  }

  function render() {
    renderWeekdays();
    const firstDay = new Date(currentYear, currentMonth, 1);
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const settings = Storage.getSettings();
    const weekStart = parseInt(settings.weekstart);
    const startDow = (firstDay.getDay() - weekStart + 7) % 7;
    const prevDays = new Date(currentYear, currentMonth, 0).getDate();
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    document.getElementById('cal-month-label').innerHTML =
      `${months[currentMonth]} <span>${currentYear}</span>`;

    const eventMap = EventModel.getForMonth(currentYear, currentMonth);
    const today = EventModel.getTodayStr();
    const grid = document.getElementById('cal-grid');
    let html = '';

    // Previous month padding
    for (let i = 0; i < startDow; i++) {
      html += `<div class="cal-day empty other-month"><div class="cal-day-num">${prevDays - startDow + i + 1}</div></div>`;
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${currentYear}-${String(currentMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const isToday = dateStr === today;
      const isSelected = dateStr === selectedDate;
      const dayEvents = eventMap[dateStr] || [];
      const dots = [...new Set(dayEvents.map(e => e.category))].slice(0,3)
        .map(cat => `<div class="cal-dot cat-${cat.toLowerCase()}"></div>`).join('');
      html += `
        <div class="cal-day${isToday?' today':''}${isSelected?' selected':''}" data-date="${dateStr}" onclick="CalendarUI.selectDate('${dateStr}')">
          <div class="cal-day-num">${d}</div>
          ${dots ? `<div class="cal-day-dots">${dots}</div>` : '<div class="cal-day-dots"></div>'}
        </div>`;
    }

    // Next month padding
    const total = startDow + daysInMonth;
    const remaining = (7 - (total % 7)) % 7;
    for (let i = 1; i <= remaining; i++) {
      html += `<div class="cal-day empty other-month"><div class="cal-day-num">${i}</div></div>`;
    }
    grid.innerHTML = html;
  }

  function selectDate(dateStr) {
    selectedDate = dateStr;
    // Update selected state in grid
    document.querySelectorAll('.cal-day').forEach(el => {
      el.classList.toggle('selected', el.dataset.date === dateStr);
    });
    renderDayPanel(dateStr);
  }

  function renderDayPanel(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    document.getElementById('dep-title').textContent = days[d.getDay()];
    document.getElementById('dep-date').textContent = `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

    const events = EventModel.getByDate(dateStr);
    const list = document.getElementById('dep-list');
    if (!events.length) {
      list.innerHTML = '<div class="dep-empty">No schedules for this day</div>';
      return;
    }
    events.sort((a,b) => (a.startTime||'').localeCompare(b.startTime||''));
    list.innerHTML = events.map(e => `
      <div class="dep-item${e.done?' done':''}" onclick="DetailModal.open('${e.id}')">
        <div class="dep-cat-dot cat-${e.category.toLowerCase()}"></div>
        <div class="dep-item-info">
          <div class="dep-item-title">${escHtml(e.title)}</div>
          <div class="dep-item-time">${formatTimeRange(e.startTime, e.endTime)}${e.alarm?' [!]':''}</div>
        </div>
        <div class="dep-item-actions">
          <button class="dep-action-btn edit" onclick="event.stopPropagation();EventFormModal.open('${e.id}')" title="Edit">&#9998;</button>
          <button class="dep-action-btn" onclick="event.stopPropagation();App.deleteEvent('${e.id}')" title="Delete">&#10005;</button>
        </div>
      </div>`).join('');
  }

  function prevMonth() {
    currentMonth--;
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    render();
  }

  function nextMonth() {
    currentMonth++;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    render();
  }

  function goToday() {
    const now = new Date();
    currentYear = now.getFullYear();
    currentMonth = now.getMonth();
    selectedDate = EventModel.getTodayStr();
    render();
    selectDate(selectedDate);
  }

  function refresh() { render(); if (selectedDate) renderDayPanel(selectedDate); }

  return { init, render, selectDate, refresh, goToday };
})();

// ============================================================
// TODAY VIEW MODULE
// ============================================================
const TodayView = (() => {
  function render() {
    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    document.getElementById('greeting-time-label').textContent = greeting;
    const greetingMain = document.getElementById('greeting-main');
    if (greetingMain) greetingMain.textContent = `${greeting}, here's your day`;

    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    document.getElementById('greeting-date').textContent =
      `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;

    const todayEvents = EventModel.getToday();
    const doneCount = todayEvents.filter(e => e.done).length;
    const upcoming = EventModel.getUpcoming(5);

    document.getElementById('stat-today').textContent = todayEvents.length;
    document.getElementById('stat-upcoming').textContent = upcoming.length;
    document.getElementById('stat-done').textContent = doneCount;

    renderEventList('today-events-list', todayEvents);
    renderEventList('upcoming-events-list', upcoming);
  }

  function renderEventList(containerId, events) {
    const container = document.getElementById(containerId);
    if (!events.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon"></div><div class="empty-title">Nothing here</div><div class="empty-sub">Add a new schedule to get started</div></div>`;
      return;
    }
    events.sort((a,b) => (a.startTime||'').localeCompare(b.startTime||''));
    container.innerHTML = events.map(e => {
      const d = new Date(e.date + 'T00:00:00');
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `
        <div class="event-card${e.done?' done':''}" onclick="DetailModal.open('${e.id}')">
          <div class="event-card-left">
            <div class="event-card-date-num">${d.getDate()}</div>
            <div class="event-card-date-month">${months[d.getMonth()]}</div>
          </div>
          <div class="event-card-body">
            <div class="event-title">${escHtml(e.title)}</div>
            ${e.description ? `<div class="event-desc">${escHtml(e.description)}</div>` : ''}
            <div class="event-meta">
              <span class="event-badge badge-${e.category.toLowerCase()}">${e.category}</span>
              ${e.startTime ? `<span class="event-time"> ${formatTimeRange(e.startTime, e.endTime)}</span>` : ''}
              ${e.alarm ? `<span class="event-alarm"></span>` : ''}
              ${e.repeat !== 'none' ? `<span class="event-time"> ${e.repeat}</span>` : ''}
            </div>
          </div>
          <div class="event-card-actions">
            <button class="dep-action-btn edit" onclick="event.stopPropagation();EventFormModal.open('${e.id}')" title="Edit">&#9998;</button>
            <button class="dep-action-btn" onclick="event.stopPropagation();App.deleteEvent('${e.id}')" title="Delete">&#10005;</button>
          </div>
        </div>`;
    }).join('');
  }

  return { render };
})();

// ============================================================
// SEARCH MODULE
// ============================================================
const SearchModule = (() => {
  let currentFilter = 'all';
  let currentQuery = '';

  function init() {
    document.getElementById('search-input').addEventListener('input', e => {
      currentQuery = e.target.value.toLowerCase();
      render();
    });
    document.getElementById('filter-row').addEventListener('click', e => {
      const chip = e.target.closest('.filter-chip');
      if (!chip) return;
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilter = chip.dataset.filter;
      render();
    });
  }

  function render() {
    const today = EventModel.getTodayStr();
    let events = EventModel.getAll();
    if (currentQuery) events = events.filter(e =>
      e.title.toLowerCase().includes(currentQuery) || e.description.toLowerCase().includes(currentQuery));
    if (currentFilter === 'upcoming') events = events.filter(e => e.date >= today);
    else if (currentFilter === 'past') events = events.filter(e => e.date < today);
    else if (currentFilter !== 'all') events = events.filter(e => e.category === currentFilter);

    events.sort((a,b) => b.date.localeCompare(a.date) || (a.startTime||'').localeCompare(b.startTime||''));

    const container = document.getElementById('search-results');
    if (!events.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon"></div><div class="empty-title">No results found</div><div class="empty-sub">Try different search terms or filters</div></div>`;
      return;
    }
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    container.innerHTML = events.map(e => {
      const d = new Date(e.date + 'T00:00:00');
      return `
        <div class="event-card${e.done?' done':''}" onclick="DetailModal.open('${e.id}')">
          <div class="event-card-left">
            <div class="event-card-date-num">${d.getDate()}</div>
            <div class="event-card-date-month">${months[d.getMonth()]}</div>
          </div>
          <div class="event-card-body">
            <div class="event-title">${escHtml(e.title)}</div>
            ${e.description ? `<div class="event-desc">${escHtml(e.description)}</div>` : ''}
            <div class="event-meta">
              <span class="event-badge badge-${e.category.toLowerCase()}">${e.category}</span>
              ${e.startTime ? `<span class="event-time"> ${formatTimeRange(e.startTime, e.endTime)}</span>` : ''}
              ${e.alarm ? `<span class="event-alarm"></span>` : ''}
            </div>
          </div>
          <div class="event-card-actions">
            <button class="dep-action-btn edit" onclick="event.stopPropagation();EventFormModal.open('${e.id}')" title="Edit">&#9998;</button>
            <button class="dep-action-btn" onclick="event.stopPropagation();App.deleteEvent('${e.id}')" title="Delete">&#10005;</button>
          </div>
        </div>`;
    }).join('');
  }

  function refresh() { render(); }
  function clear() {
    currentQuery = '';
    currentFilter = 'all';
    const input = document.getElementById('search-input');
    if (input) input.value = '';
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    const allChip = document.querySelector('.filter-chip[data-filter="all"]');
    if (allChip) allChip.classList.add('active');
  }
  return { init, refresh, clear };
})();

// ============================================================
// EVENT FORM MODAL
// ============================================================
const EventFormModal = (() => {
  let editingId = null;

  function init() {
    document.getElementById('modal-event-close').addEventListener('click', close);
    document.getElementById('btn-form-cancel').addEventListener('click', close);
    document.getElementById('btn-form-save').addEventListener('click', save);
    document.getElementById('btn-form-delete').addEventListener('click', () => {
      close();
      App.deleteEvent(editingId);
    });
    document.getElementById('modal-event').addEventListener('click', e => {
      if (e.target === document.getElementById('modal-event')) close();
    });
    document.getElementById('form-alarm').addEventListener('change', e => {
      document.getElementById('reminder-before-group').style.display = e.target.checked ? 'block' : 'none';
    });
    document.getElementById('cat-selector').addEventListener('click', e => {
      const chip = e.target.closest('.cat-chip');
      if (!chip) return;
      document.querySelectorAll('.cat-chip').forEach(c => {
        c.classList.remove('selected');
        c.style.background = '';
      });
      chip.classList.add('selected');
      setCatChipColor(chip, chip.dataset.cat);
    });
    updateCatChipColors();
  }

  function setCatChipColor(chip, cat) {
    const colors = { Event: '#34d399', Duty: '#4a90e2', Birthday: '#f472b6', Reminder: '#fbbf24', Task: '#a78bfa' };
    chip.style.background = colors[cat] || '#7c6af7';
  }

  function updateCatChipColors() {
    document.querySelectorAll('.cat-chip.selected').forEach(chip => setCatChipColor(chip, chip.dataset.cat));
  }

  function open(id = null, prefillDate = null) {
    editingId = id;
    const modal = document.getElementById('modal-event');
    document.getElementById('modal-event-title').textContent = id ? 'Edit Schedule' : 'New Schedule';
    document.getElementById('btn-form-delete').style.display = id ? 'block' : 'none';
    document.getElementById('btn-form-save').textContent = id ? 'Update' : 'Save Event';

    if (id) {
      const event = EventModel.getAll().find(e => e.id === id);
      if (event) {
        document.getElementById('form-event-id').value = event.id;
        document.getElementById('form-title').value = event.title;
        document.getElementById('form-desc').value = event.description;
        document.getElementById('form-date').value = event.date;
        document.getElementById('form-start').value = event.startTime;
        document.getElementById('form-end').value = event.endTime;
        document.getElementById('form-repeat').value = event.repeat;
        document.getElementById('form-alarm').checked = event.alarm;
        document.getElementById('form-reminder-before').value = event.reminderBefore;
        document.getElementById('reminder-before-group').style.display = event.alarm ? 'block' : 'none';
        // Set category
        document.querySelectorAll('.cat-chip').forEach(c => {
          c.classList.remove('selected'); c.style.background = '';
          if (c.dataset.cat === event.category) { c.classList.add('selected'); setCatChipColor(c, event.category); }
        });
      }
    } else {
      // Reset form
      document.getElementById('form-event-id').value = '';
      document.getElementById('form-title').value = '';
      document.getElementById('form-desc').value = '';
      document.getElementById('form-date').value = prefillDate || EventModel.getTodayStr();
      document.getElementById('form-start').value = '';
      document.getElementById('form-end').value = '';
      document.getElementById('form-repeat').value = 'none';
      document.getElementById('form-alarm').checked = false;
      document.getElementById('form-reminder-before').value = '10';
      document.getElementById('reminder-before-group').style.display = 'none';
      document.querySelectorAll('.cat-chip').forEach(c => { c.classList.remove('selected'); c.style.background = ''; });
      const firstChip = document.querySelector('.cat-chip');
      if (firstChip) { firstChip.classList.add('selected'); setCatChipColor(firstChip, firstChip.dataset.cat); }
    }
    modal.classList.add('open');
  }

  function close() {
    document.getElementById('modal-event').classList.remove('open');
    editingId = null;
  }

  function save() {
    const title = document.getElementById('form-title').value.trim();
    if (!title) { ToastModule.show('Title is required', '', 'error'); return; }
    const date = document.getElementById('form-date').value;
    if (!date) { ToastModule.show('Date is required', '', 'error'); return; }

    const selectedCat = document.querySelector('.cat-chip.selected');
    const data = {
      title,
      description: document.getElementById('form-desc').value.trim(),
      date,
      startTime: document.getElementById('form-start').value,
      endTime: document.getElementById('form-end').value,
      category: selectedCat ? selectedCat.dataset.cat : 'Event',
      alarm: document.getElementById('form-alarm').checked,
      reminderBefore: document.getElementById('form-reminder-before').value,
      repeat: document.getElementById('form-repeat').value
    };

    // Conflict detection
    if (data.startTime) {
      const conflicts = EventModel.getByDate(data.date).filter(e =>
        e.id !== editingId && e.startTime === data.startTime && !e.done
      );
      if (conflicts.length > 0) {
        ToastModule.show('Time conflict', conflicts[0].title + ' is at the same time', 'error', 4000);
        return;
      }
    }

    if (editingId) {
      AlarmModule.cancelAlarm(editingId);
      const updated = EventModel.update(editingId, data);
      if (updated && updated.alarm) AlarmModule.scheduleAlarm(updated);
      ToastModule.show('Updated', '', 'success');
    } else {
      const created = EventModel.create(data);
      if (created.alarm) AlarmModule.scheduleAlarm(created);
      ToastModule.show('Schedule added', '', 'success');
    }

    close();
    App.refreshAll();
  }

  return { init, open, close };
})();

// ============================================================
// DETAIL MODAL
// ============================================================
const DetailModal = (() => {
  let currentId = null;

  function init() {
    document.getElementById('modal-detail').addEventListener('click', e => {
      if (e.target === document.getElementById('modal-detail')) close();
    });
    document.getElementById('detail-edit-btn').addEventListener('click', () => {
      close(); EventFormModal.open(currentId);
    });
    document.getElementById('detail-delete-btn').addEventListener('click', () => {
      close(); App.deleteEvent(currentId);
    });
    document.getElementById('detail-done-btn').addEventListener('click', toggleDone);
  }

  function open(id) {
    currentId = id;
    const event = EventModel.getAll().find(e => e.id === id);
    if (!event) return;

    const icons = { Event: 'Evt', Duty: 'Dty', Birthday: 'Bday', Reminder: 'Rem', Task: 'Task' };
    const icon = icons[event.category] || '';

    document.getElementById('detail-header').innerHTML = `
      <div class="event-detail-cat-icon icon-bg-${event.category.toLowerCase()}">${icon}</div>
      <div>
        <div class="event-detail-title">${escHtml(event.title)}</div>
        <div class="event-detail-subtitle">${event.category}${event.done ? '   Done' : ''}</div>
      </div>`;

    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const d = new Date(event.date + 'T00:00:00');
    const settings = Storage.getSettings();

    let bodyHtml = `
      <div class="event-detail-row">
        <div class="event-detail-row-icon"></div>
        <div class="event-detail-row-content">
          <div class="event-detail-row-label">Date</div>
          <div class="event-detail-row-value">${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}</div>
        </div>
      </div>`;
    if (event.startTime) bodyHtml += `
      <div class="event-detail-row">
        <div class="event-detail-row-icon"></div>
        <div class="event-detail-row-content">
          <div class="event-detail-row-label">Time</div>
          <div class="event-detail-row-value">${formatTimeRange(event.startTime, event.endTime)}</div>
        </div>
      </div>`;
    if (event.description) bodyHtml += `
      <div class="event-detail-row">
        <div class="event-detail-row-icon"></div>
        <div class="event-detail-row-content">
          <div class="event-detail-row-label">Description</div>
          <div class="event-detail-row-value">${escHtml(event.description)}</div>
        </div>
      </div>`;
    if (event.repeat !== 'none') bodyHtml += `
      <div class="event-detail-row">
        <div class="event-detail-row-icon"></div>
        <div class="event-detail-row-content">
          <div class="event-detail-row-label">Repeat</div>
          <div class="event-detail-row-value">${event.repeat.charAt(0).toUpperCase() + event.repeat.slice(1)}</div>
        </div>
      </div>`;
    bodyHtml += `
      <div class="event-detail-row">
        <div class="event-detail-row-icon"></div>
        <div class="event-detail-row-content">
          <div class="event-detail-row-label">Alarm</div>
          <div class="event-detail-row-value">${event.alarm ? `Enabled  ${event.reminderBefore > 0 ? event.reminderBefore + ' min before' : 'At event time'}` : 'Disabled'}</div>
        </div>
      </div>`;

    document.getElementById('detail-body').innerHTML = bodyHtml;
    document.getElementById('detail-done-btn').textContent = event.done ? 'Unmark Done' : 'Mark Done';
    document.getElementById('modal-detail').classList.add('open');
  }

  function close() {
    document.getElementById('modal-detail').classList.remove('open');
    currentId = null;
  }

  function toggleDone() {
    if (!currentId) return;
    const event = EventModel.getAll().find(e => e.id === currentId);
    if (!event) return;
    const nowDone = !event.done;
    EventModel.update(currentId, { done: nowDone });
    if (nowDone) {
      AlarmModule.cancelAlarm(currentId);
    } else {
      AlarmModule.scheduleAlarm({ ...event, done: false });
    }
    App.refreshAll();
    ToastModule.show(nowDone ? 'Marked as done' : 'Marked as pending', '', 'success');
    close();
    App.refreshAll();
  }

  return { init, open, close };
})();

// ============================================================
// SETTINGS MODULE
// ============================================================
const SettingsModule = (() => {
  function init() {
    loadSettings();
    document.getElementById('setting-notif').addEventListener('change', save);
    document.getElementById('setting-vibrate').addEventListener('change', save);
    document.getElementById('setting-sound').addEventListener('change', save);
    document.getElementById('setting-timeformat').addEventListener('change', e => { save(); App.refreshAll(); });
    document.getElementById('setting-weekstart').addEventListener('change', e => { save(); CalendarUI.render(); });
    document.getElementById('btn-export').addEventListener('click', () => { Storage.exportData(); ToastModule.show('Data exported!', '', 'success'); });
    document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-file').click());
    document.getElementById('import-file').addEventListener('change', e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          Storage.importData(ev.target.result);
          loadSettings();
          App.refreshAll();
          ToastModule.show('Data imported!', '', 'success');
        } catch(err) { ToastModule.show('Import failed', 'Invalid file', 'error'); }
      };
      reader.readAsText(file);
      e.target.value = '';
    });
    document.getElementById('btn-clear-all').addEventListener('click', () => {
      ConfirmDialog.show('Clear All Data', 'This will delete ALL your schedules permanently. This cannot be undone!', '!', () => {
        Storage.clearAll();
        AlarmModule.cancelAll();
        App.refreshAll();
        ToastModule.show('All data cleared', '', 'success');
      });
    });
  }

  function loadSettings() {
    const s = Storage.getSettings();
    document.getElementById('setting-notif').checked = s.notif;
    document.getElementById('setting-vibrate').checked = s.vibrate;
    document.getElementById('setting-sound').value = s.sound;
    document.getElementById('setting-timeformat').value = s.timeformat;
    document.getElementById('setting-weekstart').value = s.weekstart;
  }

  function save() {
    const s = {
      notif: document.getElementById('setting-notif').checked,
      vibrate: document.getElementById('setting-vibrate').checked,
      sound: document.getElementById('setting-sound').value,
      timeformat: document.getElementById('setting-timeformat').value,
      weekstart: document.getElementById('setting-weekstart').value
    };
    Storage.saveSettings(s);
  }

  return { init, loadSettings };
})();

// ============================================================
// CONFIRM DIALOG MODULE
// ============================================================
const ConfirmDialog = (() => {
  let _callback = null;

  function init() {
    document.getElementById('confirm-cancel').addEventListener('click', close);
    document.getElementById('confirm-ok').addEventListener('click', () => {
      if (_callback) _callback();
      close();
    });
    document.getElementById('confirm-overlay').addEventListener('click', e => {
      if (e.target === document.getElementById('confirm-overlay')) close();
    });
  }

  function show(title, msg, icon, callback) {
    _callback = callback;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-msg').textContent = msg;
    document.getElementById('confirm-icon').textContent = icon || '';
    document.getElementById('confirm-overlay').classList.add('open');
  }

  function close() {
    document.getElementById('confirm-overlay').classList.remove('open');
    _callback = null;
  }

  return { init, show, close };
})();

// ============================================================
// NAVIGATION MODULE
// ============================================================
const Navigation = (() => {
  let currentView = 'calendar';

  function init() {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (view === 'add') {
          EventFormModal.open();
          return;
        }
        switchTo(view);
      });
    });
  }

  function switchTo(view) {
    currentView = view;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    const viewEl = document.getElementById(`view-${view}`);
    if (viewEl) viewEl.classList.add('active');
    const navEl = document.querySelector(`.nav-item[data-view="${view}"]`);
    if (navEl) navEl.classList.add('active');

    // Refresh view on switch
    if (view === 'today') TodayView.render();
    if (view === 'search') { SearchModule.clear(); SearchModule.refresh(); }
  }

  return { init, switchTo };
})();

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatTimeRange(start, end) {
  if (!start) return '';
  const settings = Storage.getSettings();
  const fmt = settings.timeformat;
  const fmtTime = t => {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    if (fmt === '24') return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
  };
  return end ? `${fmtTime(start)}  ${fmtTime(end)}` : fmtTime(start);
}

// ============================================================
// MAIN APP MODULE
// ============================================================
const App = (() => {
  function init() {
    // Seed sample data if empty
    if (!EventModel.getAll().length) seedSampleData();

    ThemeModule.init();
    ClockModule.init();
    CalendarUI.init();
    Navigation.init();
    EventFormModal.init();
    DetailModal.init();
    SettingsModule.init();
    SearchModule.init();
    ConfirmDialog.init();
    TodayView.render();
    AlarmModule.requestPermission();
    WeatherModule.load();

    // Birthday reminder check
    checkBirthdays();

    // Schedule all alarms
    AlarmModule.scheduleAll();

    // Alarm check interval (every minute)
    setInterval(checkAlarms, 60000);

    // Hide loader
    setTimeout(() => {
      const loader = document.getElementById('loader');
      loader.style.opacity = '0';
      setTimeout(() => loader.remove(), 400);
    }, 1400);
  }

  function seedSampleData() {
    const today = EventModel.getTodayStr();
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const tmrStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}`;
    const nextWeek = new Date(); nextWeek.setDate(nextWeek.getDate() + 5);
    const nwStr = `${nextWeek.getFullYear()}-${String(nextWeek.getMonth()+1).padStart(2,'0')}-${String(nextWeek.getDate()).padStart(2,'0')}`;

    EventModel.create({ title: 'Morning Duty', description: 'Daily morning shift', date: today, startTime: '08:00', endTime: '12:00', category: 'Duty', alarm: true, reminderBefore: 10, repeat: 'daily' });
    EventModel.create({ title: 'Team Stand-up', description: 'Daily sync with team', date: today, startTime: '09:30', endTime: '10:00', category: 'Event', alarm: true, reminderBefore: 5, repeat: 'none' });
    EventModel.create({ title: 'Submit Report', description: 'Monthly progress report', date: today, startTime: '17:00', endTime: '', category: 'Reminder', alarm: true, reminderBefore: 30, repeat: 'none' });
    EventModel.create({ title: 'Doctor Appointment', description: 'Annual checkup', date: tmrStr, startTime: '10:00', endTime: '11:00', category: 'Event', alarm: true, reminderBefore: 60, repeat: 'none' });
    EventModel.create({ title: 'Mom\'s Birthday ', description: 'Don\'t forget the cake!', date: nwStr, startTime: '00:00', endTime: '', category: 'Birthday', alarm: true, reminderBefore: 1440, repeat: 'yearly' });
    EventModel.create({ title: 'Project Deadline', description: 'Submit final project files', date: nwStr, startTime: '18:00', endTime: '', category: 'Task', alarm: true, reminderBefore: 60, repeat: 'none' });
  }

  function deleteEvent(id) {
    ConfirmDialog.show('Delete', 'This schedule will be permanently deleted.', 'X', () => {
      AlarmModule.cancelAlarm(id);
      EventModel.remove(id);
      ToastModule.show('Deleted', '', 'success');
      refreshAll();
    });
  }

  function refreshAll() {
    CalendarUI.refresh();
    TodayView.render();
    SearchModule.refresh();
  }

  function checkBirthdays() {
    const today = EventModel.getTodayStr();
    const todayEvents = EventModel.getByDate(today);
    const birthdays = todayEvents.filter(e => e.category === 'Birthday');
    birthdays.forEach(b => {
      setTimeout(() => ToastModule.show(`Birthday: ${b.title}`, 'Today is their birthday!', 'alarm', 6000), 2000);
    });
  }

  function checkAlarms() {
    AlarmModule.scheduleAll();
  }

  return { init, deleteEvent, refreshAll };
})();

// ============================================================

// ================================================================
// THEME MODULE
// ================================================================
const ThemeModule = (() => {
  const KEY = 'planify_theme';

  function init() {
    const saved = localStorage.getItem(KEY) || 'dark';
    apply(saved);
    document.getElementById('btn-theme-toggle').addEventListener('click', toggle);
  }

  function apply(theme) {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      document.getElementById('theme-icon-moon').style.display = 'none';
      document.getElementById('theme-icon-sun').style.display = 'block';
    } else {
      document.documentElement.removeAttribute('data-theme');
      document.getElementById('theme-icon-moon').style.display = 'block';
      document.getElementById('theme-icon-sun').style.display = 'none';
    }
    localStorage.setItem(KEY, theme);
  }

  function toggle() {
    const current = localStorage.getItem('planify_theme') || 'dark';
    apply(current === 'dark' ? 'light' : 'dark');
  }

  return { init };
})();
// ================================================================
// WEATHER MODULE  (Open-Meteo — no API key required)
// ================================================================

// ================================================================
// WEATHER MODULE
// ================================================================
const WeatherModule = (() => {
  const WMO = {
    0:'Clear sky',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',
    45:'Foggy',48:'Icy fog',51:'Light drizzle',53:'Drizzle',55:'Heavy drizzle',
    61:'Light rain',63:'Rain',65:'Heavy rain',71:'Light snow',73:'Snow',75:'Heavy snow',
    80:'Rain showers',81:'Showers',82:'Heavy showers',95:'Thunderstorm',99:'Thunderstorm'
  };
  const ICONS = {
    0:'☀️',1:'🌤️',2:'⛅',3:'☁️',45:'🌫️',48:'🌫️',
    51:'🌦️',53:'🌦️',55:'🌧️',61:'🌧️',63:'🌧️',65:'🌧️',
    71:'🌨️',73:'❄️',75:'❄️',80:'🌦️',81:'🌧️',82:'⛈️',95:'⛈️',99:'⛈️'
  };

  let _refreshTimer = null;

  function load() {
    document.getElementById('weather-loading').style.display = 'block';
    document.getElementById('weather-content').style.display = 'none';
    document.getElementById('weather-error').style.display = 'none';
    if (_refreshTimer) clearInterval(_refreshTimer);
    _refreshTimer = setInterval(load, 30 * 60 * 1000); // refresh every 30 min

    if (!navigator.onLine) {
      document.getElementById('weather-loading').style.display = 'none';
      document.getElementById('weather-error').style.display = 'flex';
      document.getElementById('weather-error').querySelector('span').textContent = 'No internet connection';
      return;
    }
    if (!navigator.geolocation) { showError(); return; }

    navigator.geolocation.getCurrentPosition(
      pos => fetchWeather(pos.coords.latitude, pos.coords.longitude),
      () => { fetchWeather(40.7128, -74.0060); document.getElementById('weather-loc').textContent = 'New York (location unavailable)'; }
    , { timeout: 8000 });
  }

  function fetchWeather(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&wind_speed_unit=mph&temperature_unit=celsius&timezone=auto`;
    fetch(url)
      .then(r => r.json())
      .then(data => {
        const c = data.current;
        const code = c.weather_code;
        document.getElementById('weather-temp').textContent = Math.round(c.temperature_2m) + '°C';
        document.getElementById('weather-desc').textContent = WMO[code] || 'Unknown';
        document.getElementById('weather-icon').textContent = ICONS[code] || '🌡️';
        document.getElementById('weather-humidity').textContent = c.relative_humidity_2m + '%';
        document.getElementById('weather-wind').textContent = Math.round(c.wind_speed_10m) + ' mph';
        document.getElementById('weather-feels').textContent = Math.round(c.apparent_temperature) + '°C';
        // Reverse geocode city name
        fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`)
          .then(r => r.json())
          .then(geo => {
            const city = geo.address.city || geo.address.town || geo.address.village || geo.address.county || '';
            const country = geo.address.country_code ? geo.address.country_code.toUpperCase() : '';
            document.getElementById('weather-loc').textContent = city ? `${city}, ${country}` : `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
          }).catch(() => {
            document.getElementById('weather-loc').textContent = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
          });
        document.getElementById('weather-loading').style.display = 'none';
        document.getElementById('weather-content').style.display = 'flex';
      })
      .catch(() => showError());
  }

  function showError() {
    document.getElementById('weather-loading').style.display = 'none';
    document.getElementById('weather-error').style.display = 'flex';
  }

  return { load };
})();

// ================================================================
// CLOCK MODULE
// ================================================================
const ClockModule = (() => {
  let _timer = null;

  function init() {
    tick();
    _timer = setInterval(tick, 1000);
  }

  function tick() {
    const el = document.getElementById('live-clock');
    if (!el) return;
    const now = new Date();
    const settings = Storage.getSettings();
    const fmt = settings.timeformat || '12';
    let h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();
    const pad = n => String(n).padStart(2, '0');
    let timeStr;
    if (fmt === '24') {
      timeStr = `${pad(h)}:${pad(m)}<span class="clock-sec">:${pad(s)}</span>`;
    } else {
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      timeStr = `${pad(h)}:${pad(m)}<span class="clock-sec">:${pad(s)}</span> <span class="clock-ampm">${ampm}</span>`;
    }
    el.innerHTML = timeStr;
  }

  return { init };
})();

// BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', App.init);
