// ==UserScript==
// @name         HH.ru Auto Responder  v2.1.2
// @namespace    http://tampermonkey.net/
// @version      v2.1.2
// @description  Авто-отклики на hh.ru
// @author       Timur Geruzov
// @match        *://*.hh.ru/search/vacancy*
// @match        *://*.hh.ru/vacancy/*
// @match        *://*.hh.ru/applicant/vacancy_response*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=hh.ru
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // Настройки хранилищ и ключи для local/session storage
    const STORAGE_PREFIX = 'hh_ar_v2_';
    const KEYS = {
        settings: STORAGE_PREFIX + 'cfg_data',
        isRunning: STORAGE_PREFIX + 'is_active',
        returnUrl: STORAGE_PREFIX + 'list_url',
        history: STORAGE_PREFIX + 'processed_ids',
        needF5: STORAGE_PREFIX + 'reload_flag',
        trapLock: STORAGE_PREFIX + 'ar_trap_lock',
        instanceLock: STORAGE_PREFIX + 'instance_lock',
        lastAttempt: STORAGE_PREFIX + 'last_attempt_id',
        state: STORAGE_PREFIX + 'state',
        manualList: STORAGE_PREFIX + 'manual_list'
    };

    // Важные селекторы, используемые в скрипте
    const SELECTORS = {
        applyBtn: '[data-qa="vacancy-serp__vacancy_response"], button[data-qa="vacancy-serp__vacancy_response"]',
        topApply: '[data-qa="vacancy-response-link-top"], a[data-qa="vacancy-response-link-top"]',
        modalAddCover: '[data-qa="add-cover-letter"]',
        modalTextarea: 'textarea[data-qa="vacancy-response-popup-form-letter-input"], textarea[name="coverLetter"], textarea[name="text"]',
        modalSubmit: '[data-qa="vacancy-response-submit-popup"], button[data-qa="vacancy-response-letter-submit"], button[data-qa="vacancy-response-submit-popup"]',
        nativeWrapper: '[data-qa="textarea-native-wrapper"]',
        relocationBtn: '[data-qa="relocation-warning-confirm"]',
        vacancyLink: 'a[data-qa="serp-item__title"], a[data-qa="vacancy-serp__vacancy-title"]',
        vacancyCard: 'div[data-qa="vacancy-serp__vacancy"], .vacancy-serp-item'
    };


    // Параметры по умолчанию
    const DEFAULTS = {
        coverText: 'Добрый день! Заинтересовала ваша вакансия. Опыт релевантен, подробности в резюме. Буду рад обратной связи!',
        useCover: true,
        delayMin: 2000,
        delayMax: 5000,
        limit: 50,
        skipHidden: true,
        viewMin: 8000,
        viewMax: 25000,
        scrollStepMs: 200,
        actionDelayMin: 150,
        actionDelayMax: 700,
        waitForModalMs: 8000,
        instanceLockTtl: 30000
    };

    // Небольшой менеджер состояния — работа с local/session storage
    const StateManager = {
        loadConfig: () => {
            try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEYS.settings) || '{}') }; }
            catch { return { ...DEFAULTS }; }
        },
        saveConfig: (s) => localStorage.setItem(KEYS.settings, JSON.stringify(s)),
        getProcessedIDs: () => {
            try { return new Set(JSON.parse(sessionStorage.getItem(KEYS.history) || '[]')); }
            catch { return new Set(); }
        },
        addProcessedID: (id) => {
            const s = StateManager.getProcessedIDs();
            s.add(id);
            sessionStorage.setItem(KEYS.history, JSON.stringify([...s]));
        },
        clearProcessedIDs: () => sessionStorage.removeItem(KEYS.history),
        amIRunning: () => sessionStorage.getItem(KEYS.isRunning) === '1',
        setRunning: (state) => state ? sessionStorage.setItem(KEYS.isRunning, '1') : sessionStorage.removeItem(KEYS.isRunning),
        setReturnUrl: (url) => sessionStorage.setItem(KEYS.returnUrl, url || location.href),
        getReturnUrl: () => sessionStorage.getItem(KEYS.returnUrl),
        setF5Needed: () => sessionStorage.setItem(KEYS.needF5, '1'),
        isF5Needed: () => sessionStorage.getItem(KEYS.needF5) === '1',
        clearF5Flag: () => sessionStorage.removeItem(KEYS.needF5),
        // "Ловушка" — пометка, что мы уже обрабатываем возврат с тестовой страницы
        setTrapLock: () => {
            sessionStorage.setItem(KEYS.trapLock, '1');
            // авто-очистка через 15 сек, если что-то пошло не так
            setTimeout(() => {
                if (sessionStorage.getItem(KEYS.trapLock) === '1') {
                    sessionStorage.removeItem(KEYS.trapLock);
                    log('Очистил ar_trap_lock по таймауту.');
                }
            }, 15000);
        },
        clearTrapLock: () => sessionStorage.removeItem(KEYS.trapLock),
        hasTrapLock: () => sessionStorage.getItem(KEYS.trapLock) === '1',
        // Запоминаем последнюю попытку отклика — пригодится при редиректах
        setLastAttemptID: (id) => {
            if (id) sessionStorage.setItem(KEYS.lastAttempt, id);
        },
        getLastAttemptID: () => sessionStorage.getItem(KEYS.lastAttempt),
        clearLastAttemptID: () => sessionStorage.removeItem(KEYS.lastAttempt),
        // Простая кросс-вкладочная блокировка (instance lock)
        acquireInstanceLock: (tabId) => {
            try {
                const now = Date.now();
                const raw = localStorage.getItem(KEYS.instanceLock);
                if (raw) {
                    const obj = JSON.parse(raw);
                    if (now - obj.ts < config.instanceLockTtl && obj.tabId !== tabId) {
                        return false;
                    }
                }
                localStorage.setItem(KEYS.instanceLock, JSON.stringify({ tabId, ts: now }));
                return true;
            } catch (e) { return true; }
        },
        releaseInstanceLock: (tabId) => {
            try {
                const raw = localStorage.getItem(KEYS.instanceLock);
                if (!raw) return;
                const obj = JSON.parse(raw);
                if (obj.tabId === tabId) localStorage.removeItem(KEYS.instanceLock);
            } catch (e) { /* ignore */ }
        },
        // Обновляем timestamp блокировки, чтобы другие вкладки видели, что мы живы
        touchInstanceLock: (tabId) => {
            try {
                const raw = localStorage.getItem(KEYS.instanceLock);
                if (!raw) return;
                const obj = JSON.parse(raw);
                if (obj.tabId === tabId) localStorage.setItem(KEYS.instanceLock, JSON.stringify({ tabId, ts: Date.now() }));
            } catch (e) { /* ignore */ }
        },

        // --- manual list (vacancies that require manual answering) ---
        getManualList: () => {
            try { return JSON.parse(localStorage.getItem(KEYS.manualList) || '[]'); }
            catch { return []; }
        },
        addManualEntry: (entry) => {
            try {
                const list = StateManager.getManualList();
                const exists = list.find(e => e.vid === entry.vid || e.url === entry.url);
                if (!exists) {
                    list.unshift(entry);
                    // ограничим длину списка, чтобы не раздувался
                    if (list.length > 500) list.length = 500;
                    localStorage.setItem(KEYS.manualList, JSON.stringify(list));
                }
            } catch (e) { console.warn('addManualEntry error', e); }
        },
        removeManualEntry: (vid) => {
            try {
                const list = StateManager.getManualList().filter(e => e.vid !== vid);
                localStorage.setItem(KEYS.manualList, JSON.stringify(list));
            } catch (e) { console.warn('removeManualEntry error', e); }
        },
        clearManualList: () => localStorage.removeItem(KEYS.manualList)
    };

    let config = StateManager.loadConfig();
    let isLoopActive = false;
    let stopSignal = false;
    const TAB_ID = Math.random().toString(36).slice(2, 9);

    // Пытаемся поставить кросс-вкладочный lock — если не получилось, предупреждаем в консоли
    const hasInstance = StateManager.acquireInstanceLock(TAB_ID);
    if (!hasInstance) {
        console.warn('[HH-AR] Похоже, в другой вкладке уже запущен процесс. Продолжаю, но возможны дубликаты.');
    }

    // Утилиты
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const actionPause = async () => await wait(randomDelay(config.actionDelayMin, config.actionDelayMax));
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    // Лог в панели + консоль
    const log = (msg, isError = false) => {
        const timestamp = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.textContent = `[${timestamp}] ${msg}`;
        entry.dataset.error = isError ? '1' : '0';
        if (isError) entry.style.color = '#ff4d4f';
        const logBox = document.getElementById('ar-log-box');
        if (logBox) {
            const errorsOnly = document.getElementById('ar-log-errors-only');
            entry.style.display = (errorsOnly && errorsOnly.checked && !isError) ? 'none' : 'block';
            logBox.appendChild(entry);
            logBox.scrollTop = logBox.scrollHeight;
        }
        console.log(`[HH-AR] ${msg}`);
    };

    const statusColors = {
        idle: { bg: '#e5e7eb', fg: '#111827', text: 'Ожидание' },
        running: { bg: '#dcfce7', fg: '#166534', text: 'В работе' },
        stopped: { bg: '#fee2e2', fg: '#991b1b', text: 'Остановлено' },
        error: { bg: '#fef3c7', fg: '#92400e', text: 'Ошибка/внимание' },
        done: { bg: '#e0f2fe', fg: '#075985', text: 'Завершено' }
    };

    function setStatus(statusKey, customText) {
        const st = statusColors[statusKey] || statusColors.idle;
        const el = document.getElementById('ar-status-text');
        if (!el) return;
        el.textContent = customText || st.text;
        el.style.background = st.bg;
        el.style.color = st.fg;
        el.style.border = `1px solid ${st.fg}22`;
        el.style.padding = '2px 8px';
        el.style.borderRadius = '10px';
    }

    // Корректная вставка текста в textarea (учитывает React/Magritte)
    function fillTextarea(el, value) {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
            if (descriptor && descriptor.set) {
                 descriptor.set.call(el, value);
            } else {
                 el.value = value;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            // Обновляем визуальный wrapper, если он есть
            const wrapper = el.closest(SELECTORS.nativeWrapper) || el.parentElement;
            const clone = wrapper?.querySelector('pre');
            if (clone) clone.textContent = value || '\u200B';
        } catch (e) { console.warn('fillTextarea error', e); }
    }

    // Ждём появления элемента — MutationObserver помогает при динамическом DOM
    async function waitForElement(selector, timeout = config.waitForModalMs) {
        const el = document.querySelector(selector);
        if (el) return el;
        return new Promise((resolve) => {
            const observer = new MutationObserver(() => {
                const found = document.querySelector(selector);
                if (found) {
                    observer.disconnect();
                    resolve(found);
                }
            });
            observer.observe(document.documentElement || document, { childList: true, subtree: true });
            setTimeout(() => {
                observer.disconnect();
                resolve(null);
            }, timeout);
        });
    }

    // Человеческий скролл: вниз до 60% страницы, пауза, и возврат вверх
    async function humanScrollToCompanySectionAndReturn(viewTime) {
        try {
            await actionPause();

            const stepMs = Math.max(100, config.scrollStepMs || DEFAULTS.scrollStepMs);
            const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            const winH = window.innerHeight || document.documentElement.clientHeight;
            const maxY = Math.max(0, docHeight - winH);

            const needle = 'подходящие вакансии в этой компании';
            let sectionEl = null;
            const candidates = Array.from(document.querySelectorAll('h1,h2,h3,h4,div,section'));
            for (const el of candidates) {
                try {
                    if (!el.innerText) continue;
                    if (el.innerText.trim().toLowerCase().includes(needle)) {
                        sectionEl = el;
                        break;
                    }
                } catch (e) { continue; }
            }

            let targetY = null;
            if (sectionEl) {
                const rect = sectionEl.getBoundingClientRect();
                targetY = Math.max(0, Math.round(rect.top + window.pageYOffset - 100));
                if (targetY > maxY) targetY = maxY;
                log('Найдена секция "Подходящие вакансии..." — скроллю до неё.');
            } else {
                targetY = Math.round(maxY * 0.6);
                log('Секция не найдена — скроллю до 60% страницы (фоллбек).');
            }

            const totalSteps = Math.max(6, Math.floor((viewTime / stepMs) / 2));
            const startY = window.pageYOffset || 0;

            for (let i = 1; i <= totalSteps; i++) {
                if (stopSignal) return;
                const frac = i / totalSteps;
                const y = Math.round(startY + (targetY - startY) * frac);
                window.scrollTo({ top: y, behavior: 'auto' });
                await wait(stepMs + randomDelay(-Math.floor(stepMs/3), Math.floor(stepMs/3)));
                await actionPause();
            }

            await wait(randomDelay(800, 1600));
            await actionPause();

            const upSteps = Math.max(4, Math.floor(totalSteps / 2));
            for (let i = upSteps; i >= 0; i--) {
                if (stopSignal) return;
                const frac = i / upSteps;
                const y = Math.round(startY + (targetY - startY) * frac);
                window.scrollTo({ top: y, behavior: 'auto' });
                await wait(stepMs + randomDelay(-Math.floor(stepMs/4), Math.floor(stepMs/4)));
                await actionPause();
            }

            window.scrollTo({ top: 0, behavior: 'auto' });
            await wait(200 + randomDelay(0, 500));
            await actionPause();
        } catch (e) {
            console.warn('humanScrollToCompanySectionAndReturn error', e);
        }
    }

    // Watchdog: если попали на страницу с вопросами — пытаемся безопасно вернуться и помечаем вакансию
    function watchTheURL() {
        setInterval(() => {
            // Обновляем timestamp instance lock
            StateManager.touchInstanceLock(TAB_ID);

            if (!StateManager.amIRunning()) return;

            // Если оказались на странице вопросов/теста
            if (location.href.includes('/applicant/vacancy_response')) {
                if (!StateManager.hasTrapLock()) {
                    StateManager.setTrapLock();
                    log('Попали на вопросы/тест. Инициирую возврат (попытка history.go(-2)).', true);

                    // Старательно пытаемся найти ID вакансии, чтобы пометить её как обработанную
                    let vid = null;
                    try {
                        if (document.referrer) {
                            vid = getVacancyIDFromHref(document.referrer);
                            if (vid) vid = 'v_' + vid;
                        }
                    } catch (e) { /* ignore */ }

                    if (!vid) {
                        const last = StateManager.getLastAttemptID();
                        if (last) vid = last;
                    }

                    if (!vid) {
                        const cur = getVacancyIDFromHref(location.href);
                        if (cur) vid = 'v_' + cur;
                    }

                    const savedBack = StateManager.getReturnUrl();

                    // Сохраняем текущую страницу с вопросами для ручного отклика
                    try {
                        const manualUrl = location.href;
                        const entry = { vid: vid || ('u_' + fnv1a32(manualUrl).toString(36)), url: manualUrl, returnUrl: savedBack || '', ts: Date.now() };
                        StateManager.addManualEntry(entry);
                        log(`Сохранена вакансия для ручного отклика: ${entry.vid}`);
                    } catch (e) { console.warn('save manual entry error', e); }

                    if (vid) {
                        StateManager.addProcessedID(vid);
                        log(`Пометил вакансию ${vid} как обработанную (чтобы избежать зацикливания).`);
                        StateManager.clearLastAttemptID();
                    } else {
                        log('Не удалось определить ID вакансии на странице с вопросами.', true);
                    }

                    StateManager.setF5Needed(); // после возвращения нужно обновить список
                    const backUrl = StateManager.getReturnUrl();

                    // Пытаемся откатиться двумя шагами назад: list <- vacancy <- applicant
                    try {
                        history.go(-2);
                    } catch (e) {
                        history.back();
                    }

                    // Если через 1.2 сек всё ещё на странице с тестом — форсим переход по сохранённому URL
                    setTimeout(() => {
                        if (location.href.includes('/applicant/vacancy_response')) {
                            if (backUrl) {
                                log('Двухшаговый возврат не сработал. Перехожу по сохранённому URL.', true);
                                window.location.href = backUrl;
                            } else {
                                log('Двухшаговый возврат не сработал и returnUrl недоступен. Делаю history.back().', true);
                                history.back();
                            }
                        }
                    }, 1200);
                }
            }
            // Если вернулись на список вакансий — снимаем ловушку и при необходимости обновляем страницу
            else if (document.querySelector(SELECTORS.applyBtn) || location.href.includes('/search/vacancy')) {
                 StateManager.clearTrapLock();

                 if (StateManager.isF5Needed()) {
                     log('Возврат выполнен. Перезагружаю страницу, чтобы обновить список вакансий...');
                     StateManager.clearF5Flag();
                     window.location.reload();
                 }
            }
        }, 1000);
    }

    // Попытки извлечь ID вакансии из URL в разных форматах
    function getVacancyIDFromHref(href) {
        if (!href) return null;
        const m1 = href.match(/\/vacancy\/(\d+)/);
        if (m1) return String(m1[1]);
        const m2 = href.match(/[?&]vacancyId=(\d+)/);
        if (m2) return String(m2[1]);
        const m3 = href.match(/vacancyId%3D(\d+)/);
        if (m3) return String(m3[1]);
        return null;
    }

    // Простой стабильный хеш (FNV-1a 32) — запасной вариант
    function fnv1a32(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
            h >>>= 0;
        }
        return h >>> 0;
    }

    // Получение уникального ID вакансии для отслеживания — сначала по ссылке, затем по хешу
    function getVacancyID(node) {
        try {
            const card = node.closest ? node.closest(SELECTORS.vacancyCard) : null;
            const link = (card && card.querySelector) ? card.querySelector(SELECTORS.vacancyLink) : null;
            const href = (link && link.href) || node.href || (node.getAttribute && node.getAttribute('href')) || '';
            const id = getVacancyIDFromHref(href);
            if (id) return 'v_' + id;
            let text = '';
            if (card && card.innerText) text = card.innerText.slice(0, 300);
            if (!text && href) text = href;
            if (!text) text = (document.title || '') + '|' + (card ? card.dataset?.id || '' : '');
            const h = fnv1a32(text);
            return 'h_' + h.toString(36);
        } catch (e) {
            return 'h_' + (Date.now()).toString(36);
        }
    }

    // Единый способ получить стабильный ID вакансии на странице
    function getStableVacancyId(btn) {
        const direct = getVacancyIDFromHref(location.href);
        if (direct) return 'v_' + direct;
        const last = StateManager.getLastAttemptID();
        if (last) return last;
        return getVacancyID(btn || document);
    }

    // Открываем вакансию с списка: запоминаем lastAttempt и переходим по ссылке
    async function processVacancyOnListing(vacancyLinkEl, applyBtnOnList) {
        const href = vacancyLinkEl?.href || vacancyLinkEl.getAttribute('href');
        const vid = getVacancyID(vacancyLinkEl || applyBtnOnList);

        await actionPause();
        StateManager.setReturnUrl();

        try {
            vacancyLinkEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (e) { /* ignore */ }
        await actionPause();

        if (href) {
            log(`Открываю страницу вакансии ${vid} для чтения...`);
            await actionPause();
            StateManager.setLastAttemptID(vid); // запомним, на какую вакансию кликаем
            window.location.href = href;
            return 'NAVIGATED';
        } else {
            log('Не удалось получить href вакансии — пропускаю.', true);
            return 'ERROR_NO_HREF';
        }
    }

    // Обработка вакансии: работает и на странице вакансии, и для кнопки на листинге
    async function processVacancy(btn) {
        if (stopSignal) return 'STOPPED';

        if (location.pathname.startsWith('/vacancy/')) {
            const vid = getStableVacancyId(btn);
            StateManager.setReturnUrl(document.referrer || '/search/vacancy');

            const viewTime = randomDelay(config.viewMin, config.viewMax);
            log(`Читаю ~${Math.round(viewTime/1000)} сек (имитирую просмотр страницы).`);
            await humanScrollToCompanySectionAndReturn(viewTime);

            await actionPause();
            if (stopSignal) return 'STOPPED';

            let applyBtn = document.querySelector(SELECTORS.topApply) || await waitForElement(SELECTORS.applyBtn, config.waitForModalMs);
            if (!applyBtn) {
                // Если нас уже редиректнуло на страницу с вопросами — помечаем вакансию и уходим
                if (location.href.includes('/applicant/vacancy_response')) {
                    StateManager.addProcessedID(vid);
                    StateManager.clearLastAttemptID();
                    return 'REDIRECT';
                }
                // Если кнопки нет — помечаем вакансию обработанной и возвращаемся к списку
                StateManager.addProcessedID(vid);
                StateManager.clearLastAttemptID();
                StateManager.setF5Needed();
                log('Кнопка "Откликнуться" не найдена — помечаю вакансию как обработанную и возвращаюсь.', true);

                const backUrl = StateManager.getReturnUrl();
                if (backUrl && backUrl.includes('/search/vacancy')) {
                    try {
                        window.location.href = backUrl;
                    } catch (e) {
                        try { history.back(); } catch (err) { /* ignore */ }
                    }
                } else {
                    try { history.back(); } catch (e) { /* ignore */ }
                }
                return 'NO_APPLY_RETURNED';
            }

            // Пометим, что сейчас пытаемся откликнуться на эту вакансию
            StateManager.setLastAttemptID(vid);

            window.scrollTo({ top: 0, behavior: 'auto' });
            await actionPause();
            if (stopSignal) return 'STOPPED';

            const topBtn = document.querySelector(SELECTORS.topApply);
            if (topBtn) {
                topBtn.scrollIntoView({ block: 'center', behavior: 'auto' });
                await actionPause();
                if (stopSignal) return 'STOPPED';
                topBtn.click();
            } else {
                applyBtn.scrollIntoView({ block: 'center', behavior: 'auto' });
                await actionPause();
                if (stopSignal) return 'STOPPED';
                applyBtn.click();
            }

            await actionPause();
            if (stopSignal) return 'STOPPED';

            let submitButton = await waitForElement(SELECTORS.modalSubmit, config.waitForModalMs);
            if (!submitButton) {
                const relocationBtn = document.querySelector(SELECTORS.relocationBtn);
                if (relocationBtn) {
                    await actionPause();
                    if (stopSignal) return 'STOPPED';
                    relocationBtn.click();
                    await actionPause();
                    if (stopSignal) return 'STOPPED';
                    submitButton = await waitForElement(SELECTORS.modalSubmit, config.waitForModalMs);
                }
            }

            if (!submitButton) {
                if (location.href.includes('/applicant/vacancy_response')) {
                    StateManager.addProcessedID(vid);
                    StateManager.clearLastAttemptID();
                    return 'REDIRECT';
                }
                return 'ERROR_NO_MODAL';
            }

            if (config.useCover) {
                await actionPause();
                if (stopSignal) return 'STOPPED';
                const addCoverBtn = document.querySelector(SELECTORS.modalAddCover);
                if (addCoverBtn) {
                    addCoverBtn.click();
                    await actionPause();
                    if (stopSignal) return 'STOPPED';
                    const area = await waitForElement(SELECTORS.modalTextarea, 2000);
                    if (area) {
                        fillTextarea(area, config.coverText);
                        await actionPause();
                        if (stopSignal) return 'STOPPED';
                    }
                } else {
                    const area = document.querySelector(SELECTORS.modalTextarea);
                    if (area) {
                        fillTextarea(area, config.coverText);
                        await actionPause();
                        if (stopSignal) return 'STOPPED';
                    }
                }
                await wait(randomDelay(500, 1000));
            }

            submitButton = submitButton || await waitForElement(SELECTORS.modalSubmit, 2000);

            // Дополнительные фоллбеки для новой верстки
            if (!submitButton) {
                submitButton = document.querySelector('button[data-qa="vacancy-response-letter-submit"], button[data-qa="vacancy-response-submit-popup"]');
            }
            if (!submitButton) {
                // пробуем найти саму форму и её submit внутри или вызвать form.submit()
                const form = document.querySelector('form[action="/applicant/vacancy_response/edit_ajax"], form[id^="cover-letter-"]');
                if (form) {
                    const btn = form.querySelector('button[type="submit"], input[type="submit"]');
                    if (btn) submitButton = btn;
                    else {
                        try { form.submit(); log('Отправил форму через form.submit() (fallback).'); }
                        catch (e) { console.warn('form.submit fallback failed', e); }
                    }
                }
            }

            // --- START: более надёжный возврат после отправки ---
            await actionPause();
            if (stopSignal) return 'STOPPED';
            try { submitButton.click(); } catch(e) { try { submitButton.dispatchEvent(new MouseEvent('click', {bubbles:true})); } catch(_){} }
            await actionPause();

            // Подождать подтверждение отправки — ищем кнопку "Чат" или текст "Резюме доставлено"
            async function waitForSubmitConfirmation(timeout = 5000) {
                const start = Date.now();
                while (Date.now() - start < timeout) {
                    if (stopSignal) return false;
                    if (document.querySelector('[data-qa="vacancy-response-link-view-topic"]')) return true;
                    try {
                        const divs = Array.from(document.querySelectorAll('div'));
                        if (divs.some(el => el.innerText && el.innerText.trim().toLowerCase().includes('резюме доставлено'))) return true;
                    } catch (e) { /* ignore */ }
                    await wait(300);
                }
                return false;
            }

            const confirmed = await waitForSubmitConfirmation(5000);
            const returnUrl = StateManager.getReturnUrl() || '/search/vacancy';

            if (confirmed) {
                StateManager.addProcessedID(vid);
                StateManager.clearLastAttemptID();
                log('Отклик подтверждён — перехожу к списку вакансий.');
                if (returnUrl && returnUrl.includes('/search/vacancy')) {
                    window.location.href = returnUrl;
                } else {
                    try { history.back(); } catch (e) { window.location.href = '/search/vacancy'; }
                }
                await wait(800);
                return 'OK';
            } else {
                // fallback: попробуем history.back(), если не сработает — редирект
                log('Подтверждение не найдено — пробую history.back() (фоллбек).', true);
                try {
                    history.back();
                    // если через 1s всё ещё на странице ответов — редирект на сохранённый список
                    setTimeout(() => {
                        if (location.href.includes('/applicant/vacancy_response') || location.pathname.startsWith('/vacancy')) {
                            window.location.href = returnUrl;
                        }
                    }, 1000);
                } catch (e) {
                    window.location.href = returnUrl;
                }
                await wait(800);
                return 'NO_CONFIRM';
            }
            // --- END ---
        }

        if (btn) {
            const vacLink = btn.closest(SELECTORS.vacancyCard)?.querySelector(SELECTORS.vacancyLink)
                            || document.querySelector(SELECTORS.vacancyLink);
            if (!vacLink) {
                log('Не найден селектор ссылки вакансии. Проверьте структуру карточки.', true);
                return 'ERROR_NO_LINK';
            }
            return await processVacancyOnListing(vacLink, btn);
        }

        return 'ERROR_UNKNOWN';
    }

    // Основной цикл обработчика
    async function startLoop() {
        if (isLoopActive) return;

        // Пробуем занять instance lock заново
        if (!StateManager.acquireInstanceLock(TAB_ID)) {
            log('В другой вкладке уже запущен процесс (instance lock). Продолжаю, но возможны дубликаты.', true);
        }

        isLoopActive = true;
        stopSignal = false;
        StateManager.setRunning(true);
        setStatus('running');

        // Если уже на странице вакансии — обрабатываем её напрямую
        if (location.pathname.startsWith('/vacancy/')) {
            log('На странице вакансии — продолжаю обработку тут.');
            const res = await processVacancy();
            if (res === 'OK') {
                log('Отклик отправлен. Завершаю цикл для корректного возврата.');
                isLoopActive = false;
                setStatus('done');
                return;
            } else if (res === 'REDIRECT') {
                log('Произошёл редирект/вопрос при обработке. Завершаю; watchdog вернёт нас назад.', true);
                isLoopActive = false;
                StateManager.setRunning(false);
                setStatus('error');
                return;
            } else if (res === 'STOPPED') {
                log('Остановлено пользователем во время обработки вакансии.');
                isLoopActive = false;
                StateManager.setRunning(false);
                setStatus('stopped');
                return;
            } else if (res === 'NO_APPLY_RETURNED' || res === 'ERROR_NO_MODAL' || res === 'NO_CONFIRM') {
                log(`Обработка завершилась с кодом ${res}. Завершаю цикл.`, true);
                isLoopActive = false;
                StateManager.setRunning(false);
                setStatus('error');
                return;
            }
        }

        const allBtns = Array.from(document.querySelectorAll(SELECTORS.applyBtn));
        const processed = StateManager.getProcessedIDs();

        const targets = allBtns.filter(b => {
            if (config.skipHidden && b.offsetParent === null) return false;
            return !processed.has(getVacancyID(b));
        });

        log(`Найдено вакансий: ${allBtns.length}. Новых к обработке: ${targets.length}.`);
        let count = 0;

        for (const btn of targets) {
            if (stopSignal || count >= config.limit) break;
            if (!document.body.contains(btn)) {
                log('Кнопка исчезла из DOM — перезапускаю поиск.', true);
                break;
            }

            await actionPause();

            const result = await processVacancy(btn);

            if (result === 'OK') {
                count++;
                log(`Отклик #${count} отправлен.`);
                await actionPause();
            } else if (result === 'STOPPED') {
                log('Обработка остановлена пользователем.');
                isLoopActive = false;
                StateManager.setRunning(false);
                setStatus('stopped');
                return;
            } else if (result === 'NAVIGATED') {
                // Перешли на страницу вакансии — завершаем цикл, оставляя флаг running для авто-старта на новой странице
                log('Переход на страницу вакансии — завершаю цикл для корректной навигации.');
                isLoopActive = false;
                return;
            } else if (result === 'REDIRECT') {
                log('Редирект/внешний тест. Выход из цикла — watchdog займётся возвратом.', true);
                isLoopActive = false;
                StateManager.setRunning(false);
                setStatus('error');
                return;
            } else {
                log(`Ошибка при обработке: ${result}`, true);
            }
        }

        if (!location.href.includes('/applicant/vacancy_response')) {
             isLoopActive = false;
             StateManager.setRunning(false);
             setStatus('done');
             log(`Работа завершена. Отправлено всего: ${count}`);
        }
    }

    // UI — панель с настройками и логом
    function setupUI() {
        if (document.getElementById('ar-main-panel')) return;

        const toggleBtn = document.createElement('div');
        toggleBtn.id = 'ar-toggle-btn';
        toggleBtn.textContent = '🤖';
        toggleBtn.title = 'Открыть панель HH AutoResponder';
        toggleBtn.style.cssText = `
            position: fixed; top: 50%; right: 20px; transform: translateY(-50%);
            width: 48px; height: 48px;
            background: #222; color: #fff; border-radius: 50%; display: flex;
            align-items: center; justify-content: center; font-size: 24px; cursor: pointer;
            z-index: 99999; box-shadow: 0 6px 16px rgba(0,0,0,0.35); border: 2px solid #fff;
            user-select: none; transition: all 0.2s;
        `;
        toggleBtn.onmouseenter = () => { toggleBtn.style.transform = 'translateY(-50%) scale(1.05)'; toggleBtn.style.boxShadow = '0 10px 24px rgba(0,0,0,0.4)'; };
        toggleBtn.onmouseleave = () => { toggleBtn.style.transform = 'translateY(-50%)'; toggleBtn.style.boxShadow = '0 6px 16px rgba(0,0,0,0.35)'; };
        document.body.appendChild(toggleBtn);

        const panel = document.createElement('div');
        panel.id = 'ar-main-panel';
        panel.style.position = 'fixed';
        panel.style.bottom = '20px';
        panel.style.right = '20px';
        panel.style.width = '420px';
        panel.style.background = '#fff';
        panel.style.border = '1px solid #e0e0e0';
        panel.style.boxShadow = '0 4px 20px rgba(0,0,0,0.2)';
        panel.style.borderRadius = '12px';
        panel.style.zIndex = '99999';
        panel.style.fontFamily = 'sans-serif';
        panel.style.fontSize = '13px';
        panel.style.color = '#333';
        panel.style.overflow = 'hidden';
        panel.style.display = 'block';

        panel.innerHTML = `
            <div style="padding: 12px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; background: #f9f9f9;">
                <b>🤖 HH AutoResponder</b>
                <div style="display:flex; gap: 8px; align-items: center;">
                    <span id="ar-status-text" style="font-weight: bold; color: #666; font-size: 11px;">Ожидание</span>
                    <button id="ar-minimize-btn" style="background:none; border:none; cursor:pointer; font-size: 16px; color:#888;">—</button>
                </div>
            </div>
            <div style="padding: 12px;">
                <label style="display:block; margin-bottom: 8px; cursor: pointer;">
                    <input type="checkbox" id="ar-use-cover-check"> Сопроводительное письмо
                </label>
                <textarea id="ar-cover-text" rows="4" style="width: 100%; box-sizing: border-box; border: 1px solid #ddd; padding: 8px; border-radius: 6px; resize: vertical; margin-bottom: 12px; font-family: inherit;"></textarea>

                <div style="display: flex; gap: 10px; margin-bottom: 12px;">
                    <div style="flex: 1;">
                        <div style="font-size: 10px; color: #888; margin-bottom: 2px;">Задержка между действиями (мс)</div>
                        <div style="display:flex; align-items:center; gap: 4px;">
                            <input type="number" id="ar-min-delay" style="width: 100%; padding: 4px; border:1px solid #ddd; border-radius: 4px;" placeholder="Min">
                            <span style="color:#888">-</span>
                            <input type="number" id="ar-max-delay" style="width: 100%; padding: 4px; border:1px solid #ddd; border-radius: 4px;" placeholder="Max">
                        </div>
                    </div>
                    <div style="width: 60px;">
                        <div style="font-size: 10px; color:#888; margin-bottom:2px;">Лимит</div>
                        <input type="number" id="ar-limit-input" style="width: 100%; padding: 4px; border:1px solid #ddd; border-radius: 4px;">
                    </div>
                </div>

                <div style="display:flex; gap:8px; margin-bottom:8px;">
                    <div style="flex:1;">
                        <div style="font-size:10px; color:#888; margin-bottom:2px;">Время чтения вакансии (мс)</div>
                        <div style="display:flex; gap:4px;">
                            <input type="number" id="ar-view-min" style="width:100%; padding:4px; border:1px solid #ddd; border-radius:4px;" placeholder="Min">
                            <input type="number" id="ar-view-max" style="width:100%; padding:4px; border:1px solid #ddd; border-radius:4px;" placeholder="Max">
                        </div>
                    </div>
                </div>

                <div style="display:flex; gap:8px; margin-bottom:12px;">
                    <div style="flex:1;">
                        <div style="font-size:10px; color:#888; margin-bottom:2px;">Задержки действий (мс)</div>
                        <div style="display:flex; gap:4px;">
                            <input type="number" id="ar-action-min" style="width:100%; padding:4px; border:1px solid #ddd; border-radius:4px;" placeholder="Min">
                            <input type="number" id="ar-action-max" style="width:100%; padding:4px; border:1px solid #ddd; border-radius:4px;" placeholder="Max">
                        </div>
                    </div>
                </div>

                <div style="display: flex; gap: 8px; margin-bottom:8px;">
                    <button id="ar-start-btn" style="flex: 1; padding: 8px; background: #22c55e; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; transition: opacity 0.2s;">START</button>
                    <button id="ar-stop-btn" style="flex: 1; padding: 8px; background: #ef4444; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; transition: opacity 0.2s;">STOP</button>
                </div>

                <div style="display:flex; gap:8px; margin-bottom:10px;">
                    <button id="ar-health-btn" style="flex:1; padding:6px; border-radius:6px; border:1px solid #ddd; cursor:pointer;">Healthcheck</button>
                    <button id="ar-reset-history" style="flex:1; padding:6px; border-radius:6px; border:1px solid #ddd; cursor:pointer;">Reset history</button>
                </div>

            </div>
            <div style="padding: 12px; border-top: 1px solid #eee;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <b>Сохранённые для ручного отклика</b>
                        <span id="ar-manual-count" style="background:#eef2ff; color:#1e3a8a; padding:2px 8px; border-radius:10px; font-size:11px;">0</span>
                    </div>
                    <div style="display:flex; gap:6px;">
                        <button id="ar-export-manual" style="padding:6px; border-radius:6px; border:1px solid #ddd; cursor:pointer;">Export</button>
                        <button id="ar-clear-manual" style="padding:6px; border-radius:6px; border:1px solid #ddd; cursor:pointer;">Clear</button>
                    </div>
                </div>
                <div id="ar-manual-list" style="max-height:120px; overflow:auto; font-size:12px; border:1px solid #f0f0f0; padding:6px; border-radius:6px; background:#fafafa"></div>
            </div>
            <div style="padding: 8px 12px; border-top:1px solid #eee; display:flex; justify-content:space-between; align-items:center; background:#fafafa;">
                <label style="font-size:12px; color:#555;"><input type="checkbox" id="ar-log-errors-only" style="margin-right:6px;">Только ошибки</label>
                <button id="ar-clear-log" style="padding:6px 10px; border-radius:6px; border:1px solid #ddd; cursor:pointer;">Clear log</button>
            </div>
            <div id="ar-log-box" style="height: 140px; overflow-y: auto; background: #1e1e1e; color: #00ff00; font-family: monospace; font-size: 11px; padding: 8px; border-top: 1px solid #333;"></div>
        `;

        document.body.appendChild(panel);

        const el = (id) => document.getElementById(id);

        el('ar-cover-text').value = config.coverText;
        el('ar-use-cover-check').checked = config.useCover;
        el('ar-min-delay').value = config.delayMin;
        el('ar-max-delay').value = config.delayMax;
        el('ar-limit-input').value = config.limit;
        el('ar-view-min').value = config.viewMin;
        el('ar-view-max').value = config.viewMax;
        el('ar-action-min').value = config.actionDelayMin;
        el('ar-action-max').value = config.actionDelayMax;
        setStatus(StateManager.amIRunning() ? 'running' : 'idle');

        const saveSettings = () => {
            config.coverText = el('ar-cover-text').value;
            config.useCover = el('ar-use-cover-check').checked;
            config.delayMin = +el('ar-min-delay').value || DEFAULTS.delayMin;
            config.delayMax = +el('ar-max-delay').value || DEFAULTS.delayMax;
            config.limit = +el('ar-limit-input').value || DEFAULTS.limit;
            config.viewMin = +el('ar-view-min').value || DEFAULTS.viewMin;
            config.viewMax = +el('ar-view-max').value || DEFAULTS.viewMax;
            config.actionDelayMin = +el('ar-action-min').value || DEFAULTS.actionDelayMin;
            config.actionDelayMax = +el('ar-action-max').value || DEFAULTS.actionDelayMax;
            if (config.delayMin > config.delayMax) [config.delayMin, config.delayMax] = [config.delayMax, config.delayMin];
            if (config.viewMin > config.viewMax) [config.viewMin, config.viewMax] = [config.viewMax, config.viewMin];
            if (config.actionDelayMin > config.actionDelayMax) [config.actionDelayMin, config.actionDelayMax] = [config.actionDelayMax, config.actionDelayMin];
            StateManager.saveConfig(config);
            log('Настройки сохранены.');
        };

        ['ar-cover-text', 'ar-use-cover-check', 'ar-min-delay', 'ar-max-delay', 'ar-limit-input', 'ar-view-min', 'ar-view-max', 'ar-action-min', 'ar-action-max'].forEach(id => el(id).addEventListener('change', saveSettings));

        const applyLogFilter = () => {
            const box = el('ar-log-box');
            const chk = el('ar-log-errors-only');
            if (!box || !chk) return;
            Array.from(box.children).forEach(child => {
                child.style.display = (chk.checked && child.dataset.error !== '1') ? 'none' : 'block';
            });
        };

        const errChk = el('ar-log-errors-only');
        if (errChk) errChk.onchange = applyLogFilter;
        const clearLogBtn = el('ar-clear-log');
        if (clearLogBtn) clearLogBtn.onclick = () => {
            const box = el('ar-log-box');
            if (box) box.innerHTML = '';
        };

        el('ar-start-btn').onclick = startLoop;
        el('ar-stop-btn').onclick = () => {
            stopSignal = true;
            isLoopActive = false;
            StateManager.setRunning(false);
            setStatus('stopped');
            StateManager.releaseInstanceLock(TAB_ID);
            log('Остановлено пользователем.');
        };

        el('ar-reset-history').onclick = () => {
            StateManager.clearProcessedIDs();
            log('История откликов сброшена.');
        };

        el('ar-health-btn').onclick = () => {
            runHealthCheck();
        };

        el('ar-clear-manual').onclick = () => {
            if (confirm('Очистить сохранённый список вакансий для ручного отклика?')) {
                StateManager.clearManualList();
                renderManualList();
                log('Список для ручного отклика очищен.');
            }
        };

        // Export: интерактивный HTML, фильтры и сортировки
        el('ar-export-manual').onclick = () => {
            const list = StateManager.getManualList();
            if (!list || !list.length) { alert('Список пуст'); return; }

            // dedupe by url (avoid duplicate identical links)
            const seen = new Set();
            const uniq = [];
            let duplicates = 0;
            for (const it of list) {
                const key = String(it.url || it.vid || '').trim();
                if (!key) continue;
                if (seen.has(key)) { duplicates++; continue; }
                seen.add(key);
                uniq.push(it);
            }

            const rowsJson = JSON.stringify(uniq).replace(/<\/script/gi, '<\\/script');

            const content = `<!doctype html><html><head><meta charset="utf-8"><title>HH Manual List</title><meta name="viewport" content="width=device-width,initial-scale=1">
                <style>
                    :root { color-scheme: light; }
                    body{font-family:Arial,Helvetica,sans-serif;padding:18px;color:#0f172a;background:#f8fafc;}
                    h2{margin:0 0 8px;font-size:20px;display:flex;align-items:center;gap:8px;}
                    h2 span.badge{background:#e0f2fe;color:#075985;padding:2px 8px;border-radius:10px;font-size:12px;}
                    .meta{color:#475569;font-size:13px;margin:6px 0 12px;}
                    .controls{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px;}
                    button{cursor:pointer;border-radius:6px;border:1px solid #cbd5e1;background:#fff;padding:8px 12px;font-size:13px;}
                    button.primary{background:#0ea5e9;color:#fff;border-color:#0ea5e9;}
                    button.danger{background:#ef4444;color:#fff;border-color:#ef4444;}
                    input,select{padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;}
                    table{border-collapse:collapse;width:100%;margin-top:8px;font-size:13px;}
                    th,td{padding:9px;border:1px solid #e2e8f0;}
                    th{background:#f1f5f9;color:#0f172a;position:sticky;top:0;z-index:2;}
                    tr:nth-child(even){background:#f8fafc;}
                    a{color:#0b6ef6;text-decoration:none;word-break:break-all;}
                    .age.fresh{color:#16a34a;font-weight:600;}
                    .age.recent{color:#0ea5e9;font-weight:600;}
                    .age.stale{color:#f59e0b;font-weight:600;}
                    .age.old{color:#ef4444;font-weight:600;}
                    .tag{display:inline-block;background:#e2e8f0;color:#475569;padding:2px 6px;border-radius:6px;font-size:11px;}
                    .processed td{opacity:0.55;text-decoration:line-through;}
                    @media(max-width:720px){table, thead, tbody, th, td, tr{display:block;} th{position:static;} td{border:none;border-bottom:1px solid #e2e8f0;}}
                </style>
                </head><body>
                <h2>Saved vacancies <span class="badge" id="badge-count">${uniq.length}</span></h2>
                <div class="meta">Export date: ${new Date().toLocaleString()} • Duplicates removed: ${duplicates}</div>
                <div class="controls">
                    <input id="filter" type="text" placeholder="Фильтр по VID/тексту/URL" style="flex:1; min-width:200px;">
                    <select id="sort">
                        <option value="ts_desc">Новые → старые</option>
                        <option value="ts_asc">Старые → новые</option>
                        <option value="title_asc">Название A→Z</option>
                        <option value="title_desc">Название Z→A</option>
                    </select>
                    <select id="view-mode">
                        <option value="new">Новые</option>
                        <option value="opened">Открытые</option>
                    </select>
                    <button id="open-selected">Open selected</button>
                    <button id="clear-processed" class="danger">Удалить помеченные</button>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th style="width:40px;"><input type="checkbox" id="check-all"></th>
                            <th>Saved</th>
                            <th>VID</th>
                            <th>Title</th>
                            <th>Link</th>
                            <th>Return URL</th>
                            <th>Age</th>
                        </tr>
                    </thead>
                    <tbody id="rows"></tbody>
                </table>

                <script>
                    const data = ${rowsJson};
                    let sortKey = 'ts_desc';
                    let filterText = '';
                    let viewMode = 'new';
                    const processed = JSON.parse(localStorage.getItem('hh_ar_manual_processed') || '{}');
                    const selected = new Set();

                    const qs = (id) => document.getElementById(id);

                    function humanAgo(ts) {
                        const d = Date.now() - ts;
                        const sec = Math.floor(d/1000);
                        if (sec < 60) return sec + 's';
                        const min = Math.floor(sec/60);
                        if (min < 60) return min + 'm';
                        const hr = Math.floor(min/60);
                        if (hr < 24) return hr + 'h';
                        const day = Math.floor(hr/24);
                        return day + 'd';
                    }

                    function ageClass(ts) {
                        const days = (Date.now() - ts)/(1000*60*60*24);
                        if (days < 1) return 'fresh';
                        if (days < 3) return 'recent';
                        if (days < 7) return 'stale';
                        return 'old';
                    }

                    function applySort(arr) {
                        const sorted = [...arr];
                        sorted.sort((a,b)=>{
                            if (sortKey === 'ts_desc') return (b.ts||0)-(a.ts||0);
                            if (sortKey === 'ts_asc') return (a.ts||0)-(b.ts||0);
                            const ta = (a.title||'').toLowerCase();
                            const tb = (b.title||'').toLowerCase();
                            if (sortKey === 'title_asc') return ta.localeCompare(tb);
                            if (sortKey === 'title_desc') return tb.localeCompare(ta);
                            return 0;
                        });
                        return sorted;
                    }

                    function render() {
                        const tbody = qs('rows');
                        if (!tbody) return;
                        const ft = filterText.trim().toLowerCase();
                        const filtered = data.filter((i, idx)=>{
                            const pKey = i.vid || i.url || idx;
                            if (viewMode === 'opened') {
                                if (!processed[pKey]) return false;
                            } else {
                                if (processed[pKey]) return false;
                            }
                            if (!ft) return true;
                            return [i.vid, i.title, i.url].some(v => (v||'').toLowerCase().includes(ft));
                        });
                        const sorted = applySort(filtered);
                        let html = '';
                        sorted.forEach((i, idx)=>{
                            const ts = i.ts || Date.now();
                            const ago = humanAgo(ts);
                            const aClass = ageClass(ts);
                            const key = i.vid || i.url || idx;
                            const checked = selected.has(key) ? 'checked' : '';
                            const rowClass = processed[key] ? ' class="processed"' : '';
                            const link = i.url ? '<a data-open="1" href="' + i.url + '" target="_blank" rel="noopener noreferrer">Open</a>' : '';
                            const ret = i.returnUrl ? '<a data-back="1" href="' + i.returnUrl + '" target="_blank" rel="noopener noreferrer">Back</a>' : '<span class="tag">n/a</span>';
                            const title = (i.title && i.title.trim()) ? i.title : (i.url || '');
                            html += '<tr' + rowClass + ' data-key="' + key + '">'
                                 + '<td style="text-align:center;"><input type="checkbox" class="row-check" data-key="' + key + '" ' + checked + '></td>'
                                 + '<td>' + new Date(ts).toLocaleString() + '</td>'
                                 + '<td>' + (i.vid || '') + '</td>'
                                 + '<td>' + title + '</td>'
                                 + '<td>' + link + '</td>'
                                 + '<td>' + ret + '</td>'
                                 + '<td><span class="age ' + aClass + '">' + ago + '</span></td>'
                                 + '</tr>';
                        });
                        tbody.innerHTML = html;
                        const badge = qs('badge-count');
                        if (badge) badge.textContent = filtered.length;
                    }

                    function saveProcessed() {
                        localStorage.setItem('hh_ar_manual_processed', JSON.stringify(processed));
                    }

                    qs('filter').addEventListener('input', (e)=>{ filterText = e.target.value; render(); });
                    qs('sort').addEventListener('change', (e)=>{ sortKey = e.target.value; render(); });
                    qs('view-mode').addEventListener('change', (e)=>{
                        viewMode = e.target.value;
                        selected.clear();
                        render();
                    });

                    qs('check-all').addEventListener('change', (e)=>{
                        const state = e.target.checked;
                        document.querySelectorAll('.row-check').forEach(ch => {
                            ch.checked = state;
                            const key = ch.dataset.key;
                            if (!key) return;
                            if (state) selected.add(key);
                            else selected.delete(key);
                        });
                    });

                    qs('rows').addEventListener('change', (e)=>{
                        if (!e.target.classList.contains('row-check')) return;
                        const key = e.target.dataset.key;
                        if (!key) return;
                        if (e.target.checked) selected.add(key);
                        else selected.delete(key);
                    });

                    qs('open-selected').addEventListener('click', ()=>{
                        document.querySelectorAll('.row-check:checked').forEach(ch=>{
                            const key = ch.dataset.key;
                            const row = data.find(i => (i.vid || i.url || '') === key);
                            const url = row?.url;
                            if (url) window.open(url, '_blank');
                            if (key) processed[key] = true;
                        });
                        saveProcessed();
                        selected.clear();
                        render();
                    });

                    qs('rows').addEventListener('click', (e)=>{
                        if (e.target.tagName !== 'A') return;
                        if (e.target.dataset.open !== '1') return;
                        const row = e.target.closest('tr');
                        const key = row?.getAttribute('data-key');
                        if (!key) return;
                        processed[key] = true;
                        saveProcessed();
                        render();
                    });

                    qs('clear-processed').addEventListener('click', ()=>{
                        if (!confirm('Удалить все помеченные как обработанные?')) return;
                        const keys = Object.keys(processed);
                        keys.forEach(k => delete processed[k]);
                        saveProcessed();
                        selected.clear();
                        render();
                    });

                    // init
                    render();
                </script>
                </body></html>`;

            const blob = new Blob([content], { type: 'text/html;charset=utf-8' });
            const urlBlob = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = urlBlob; a.download = 'hh_manual_list.html';
            document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(urlBlob);
            log('HTML экспорт выполнен.');
        };

        const toggleVisibility = (isOpen) => {
            panel.style.display = isOpen ? 'block' : 'none';
            toggleBtn.style.display = isOpen ? 'none' : 'flex';
        };
        el('ar-minimize-btn').onclick = () => toggleVisibility(false);
        toggleBtn.onclick = () => toggleVisibility(true);

        // render manual list in UI
        function renderManualList() {
            const container = document.getElementById('ar-manual-list');
            if (!container) return;
            container.innerHTML = '';
            const list = StateManager.getManualList();
            const cntEl = document.getElementById('ar-manual-count');
            if (cntEl) cntEl.textContent = list?.length || 0;
            if (!list || !list.length) {
                container.innerHTML = '<div style="color:#666;">Пусто</div>';
                return;
            }
            list.forEach(item => {
                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.justifyContent = 'space-between';
                row.style.alignItems = 'center';
                row.style.padding = '6px 4px';
                row.style.borderBottom = '1px solid #eee';

                const left = document.createElement('div');
                left.style.flex = '1';
                left.style.marginRight = '8px';
                const time = new Date(item.ts).toLocaleString();
                left.innerHTML = `<div style="font-size:11px;color:#333;margin-bottom:2px;">${item.vid} • ${time}</div><div style="font-size:11px;color:#0077cc;word-break:break-all"><a href="${item.url}" target="_blank">Открыть страницу с вопросами</a></div>`;

                const actions = document.createElement('div');
                actions.style.display = 'flex';
                actions.style.gap = '6px';

                const openBtn = document.createElement('button');
                openBtn.textContent = 'Open';
                openBtn.style.padding = '4px 6px';
                openBtn.style.borderRadius = '6px';
                openBtn.style.border = '1px solid #ddd';
                openBtn.style.cursor = 'pointer';
                openBtn.onclick = () => window.open(item.url, '_blank');

                const removeBtn = document.createElement('button');
                removeBtn.textContent = 'Remove';
                removeBtn.style.padding = '4px 6px';
                removeBtn.style.borderRadius = '6px';
                removeBtn.style.border = '1px solid #ddd';
                removeBtn.style.cursor = 'pointer';
                removeBtn.onclick = () => { StateManager.removeManualEntry(item.vid); renderManualList(); };

                actions.appendChild(openBtn);
                actions.appendChild(removeBtn);

                row.appendChild(left);
                row.appendChild(actions);
                container.appendChild(row);
            });
        }

        // initial render
        applyLogFilter();
        renderManualList();

        // expose render function for other parts of script
        window._hh_ar_renderManualList = renderManualList;
    }

    // Пробегает по ключевым селекторам и пишет результат в лог
    function runHealthCheck() {
        const checks = [
            { name: 'Кнопка отклика (list)', sel: SELECTORS.applyBtn },
            { name: 'Верхняя кнопка отклика (vacancy page)', sel: SELECTORS.topApply },
            { name: 'Ссылка вакансии (card)', sel: SELECTORS.vacancyLink },
            { name: 'modal submit', sel: SELECTORS.modalSubmit },
            { name: 'modal textarea', sel: SELECTORS.modalTextarea }
        ];
        log('Запускаю HealthCheck...');
        checks.forEach(c => {
            const found = document.querySelector(c.sel);
            log(`${c.name}: ${found ? 'OK' : 'НЕ НАЙДЕНО'} (${c.sel})`, !found);
        });
        const raw = localStorage.getItem(KEYS.instanceLock);
        if (raw) {
            try {
                const obj = JSON.parse(raw);
                log(`Instance lock: tabId=${obj.tabId} ts=${new Date(obj.ts).toLocaleTimeString()}`);
            } catch (e) { log('Instance lock: ошибка чтения', true); }
        } else {
            log('Instance lock: отсутствует');
        }
    }

    // Инициализация
    watchTheURL();

    const domReadyObserver = new MutationObserver((mutations, obs) => {
        if (document.body) {
            setupUI();
            // Авто-возобновление, если скрипт был в работе перед перезагрузкой
            if (StateManager.amIRunning()) {
                log('Обнаружена незавершенная работа. Авто-возобновление через 1.5 сек...');
                setStatus('running', 'Авто-запуск...');
                setTimeout(() => {
                    const startButton = document.getElementById('ar-start-btn');
                    if (startButton) startButton.click();
                }, 1500);
            }
            // Сбрасываем ловушку при открытии новых страниц
            StateManager.clearTrapLock();
            obs.disconnect();
        }
    });
    domReadyObserver.observe(document.documentElement, { childList: true, subtree: true });

    // Очищаем instance lock при закрытии вкладки
    window.addEventListener('beforeunload', () => {
        StateManager.releaseInstanceLock(TAB_ID);
    });
    window.addEventListener('unload', () => {
        StateManager.releaseInstanceLock(TAB_ID);
    });
})();
