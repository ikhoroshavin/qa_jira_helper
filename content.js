/**
 * Jira QA Helper - Content Script
 * 
 * Функционал:
 * 1. Создание двух QA-подзадач с префиксами [Тестирование] и [Документация]
 *    с назначением текущего пользователя исполнителем
 */

/* -----------------------------
   Получение базового URL Jira
--------------------------------*/
function getJiraBaseUrl() {
  return window.location.origin;
}

/* -----------------------------------------
   Получение ключа текущей задачи из URL
-------------------------------------------*/
function getCurrentIssueKey() {
  const url = window.location.href;

  let match = url.match(/\/issues\/([A-Z0-9]+-\d+)/);
  if (match) return match[1];

  match = url.match(/\/browse\/([A-Z0-9]+-\d+)/);
  if (match) return match[1];

  match = window.location.hash.match(/([A-Z0-9]+-\d+)/);
  if (match) return match[1];

  match = url.match(/([A-Z0-9]+-\d+)/);
  if (match) return match[1];

  return null;
}

/* -----------------------------
   Получение данных задачи
------------------------------*/
async function getIssueData(issueKey) {
  const baseUrl = getJiraBaseUrl();

  const response = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}`, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    credentials: 'include'
  });

  if (!response.ok) {
    throw new Error(`Ошибка получения данных задачи: ${response.status}`);
  }

  return await response.json();
}

/* -----------------------------
   Получение текущего пользователя
------------------------------*/
async function getCurrentUser() {
  const baseUrl = getJiraBaseUrl();
  const response = await fetch(`${baseUrl}/rest/api/3/myself`, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    credentials: 'include'
  });

  if (!response.ok) {
    throw new Error(`Ошибка получения текущего пользователя: ${response.status}`);
  }

  return await response.json();
}

/* -----------------------------
   Создание подзадачи
------------------------------*/
async function createSubtask(parentKey, summary, issueTypeId, projectId, assigneeAccountId) {
  const baseUrl = getJiraBaseUrl();

  const payload = {
    fields: {
      project: { id: projectId },
      parent: { key: parentKey },
      summary: summary,
      issuetype: { id: issueTypeId },
      assignee: { id: assigneeAccountId }
    }
  };

  const response = await fetch(`${baseUrl}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Ошибка создания подзадачи: ${response.status} - ${await response.text()}`);
  }

  return await response.json();
}

/* -----------------------------
   Получение ID типа QA-subtask
------------------------------*/
async function getQASubtaskTypeId(projectKey) {
  const baseUrl = getJiraBaseUrl();

  const response = await fetch(
    `${baseUrl}/rest/api/3/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes`,
    {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      credentials: 'include'
    }
  );

  if (!response.ok) {
    throw new Error(`Ошибка получения типов задач: ${response.status}`);
  }

  const data = await response.json();
  const project = data.projects?.[0];

  if (!project) {
    throw new Error('Проект не найден');
  }

  const types = project.issuetypes;

  // 1. Ищем строгий матч QA-subtask
  const exactQA = types.find(t => t.subtask && t.name.trim().toLowerCase() === "qa-subtask");
  if (exactQA) return exactQA.id;

  // 2. Ищем вариант с точным началом "QA"
  const startsQA = types.find(t => t.subtask && /^qa/.test(t.name.toLowerCase()));
  if (startsQA) return startsQA.id;

  // 3. Ищем вариант, содержащий "qa", но не начинающийся на "aqa"
  const containsQA = types.find(
    t =>
      t.subtask &&
      t.name.toLowerCase().includes("qa") &&
      !t.name.toLowerCase().startsWith("aqa")
  );
  if (containsQA) return containsQA.id;

  // 4. Если ничего не нашли — fallback на *любой* сабтаск
  const anySubtask = types.find(t => t.subtask);
  if (anySubtask) return anySubtask.id;

  throw new Error("Тип QA-subtask не найден");
}

/* -----------------------------
   Получение ID типа задачи для конвертации
------------------------------*/
async function getStandardIssueTypeId(projectKey) {
  const baseUrl = getJiraBaseUrl();

  const response = await fetch(
    `${baseUrl}/rest/api/3/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes`,
    {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      credentials: 'include'
    }
  );

  if (!response.ok) {
    throw new Error(`Ошибка получения типов задач: ${response.status}`);
  }

  const data = await response.json();
  const project = data.projects?.[0];

  if (!project) {
    throw new Error('Проект не найден');
  }

  const nonSubtaskTypes = project.issuetypes.filter(t => !t.subtask);
  if (!nonSubtaskTypes.length) {
    throw new Error('Доступные типы задач для конвертации не найдены');
  }

  const taskType = nonSubtaskTypes.find(t => t.name.trim().toLowerCase() === "task");
  return (taskType || nonSubtaskTypes[0]).id;
}

/* -----------------------------
   Создание QA-подзадач с назначением текущего пользователя
------------------------------*/
async function createQASubtasks(button) {
  const issueKey = getCurrentIssueKey();
  if (!issueKey) return showNotification("Не удалось определить ключ задачи", "error");

  button.disabled = true;
  button.textContent = "Создание...";

  try {
    const issue = await getIssueData(issueKey);
    const summary = issue.fields.summary;
    const projectId = issue.fields.project.id;
    const projectKey = issue.fields.project.key;

    const qaType = await getQASubtaskTypeId(projectKey);
    const currentUser = await getCurrentUser();
    const assigneeId = currentUser.accountId;

    const t = await createSubtask(issueKey, `[Тестирование] ${summary}`, qaType, projectId, assigneeId);
    const d = await createSubtask(issueKey, `[Документация] ${summary}`, qaType, projectId, assigneeId);

    showNotification(`Созданы: ${t.key}, ${d.key}`, "success");
    setTimeout(() => location.reload(), 1500);

  } catch (e) {
    showNotification(e.message, "error");
    button.disabled = false;
    button.textContent = "➕ Создать QA подзадачи";
  }
}

/* -----------------------------
   Уведомления
------------------------------*/
function showNotification(message, type = "info") {
  document.querySelectorAll(".jira-qa-helper-notification").forEach(n => n.remove());

  const div = document.createElement("div");
  div.className = `jira-qa-helper-notification jira-qa-helper-notification-${type}`;
  div.textContent = message;

  document.body.appendChild(div);

  setTimeout(() => {
    div.style.opacity = "0";
    setTimeout(() => div.remove(), 300);
  }, 5000);
}

/* -----------------------------
   Конвертация подзадачи в задачу
------------------------------*/
async function convertSubtaskToIssue(issueKey, targetIssueTypeId) {
  const baseUrl = getJiraBaseUrl();

  const response = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      fields: {
        issuetype: { id: targetIssueTypeId },
        parent: null
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ошибка конвертации ${issueKey}: ${response.status} - ${await response.text()}`);
  }
}

/* -----------------------------
   Создание линка между задачами
------------------------------*/
async function createRelatesLink(sourceKey, targetKey) {
  const baseUrl = getJiraBaseUrl();

  const response = await fetch(`${baseUrl}/rest/api/3/issueLink`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      type: { name: "Relates" },
      inwardIssue: { key: sourceKey },
      outwardIssue: { key: targetKey }
    })
  });

  if (!response.ok) {
    throw new Error(`Ошибка линкования ${sourceKey} и ${targetKey}: ${response.status} - ${await response.text()}`);
  }
}

/* -----------------------------
   Конвертация QA-подзадач
------------------------------*/
async function convertQASubtasks(button) {
  const issueKey = getCurrentIssueKey();
  if (!issueKey) return showNotification("Не удалось определить ключ задачи", "error");

  button.disabled = true;
  button.textContent = "Конвертация...";

  try {
    const issue = await getIssueData(issueKey);
    const subtasks = issue.fields.subtasks || [];
    const targets = subtasks.filter(st => {
      const summary = st.fields?.summary || "";
      return summary.startsWith("[Тестирование]") || summary.startsWith("[Документация]");
    });

    if (!targets.length) {
      showNotification("Подходящие подзадачи не найдены", "warning");
      button.disabled = false;
      button.textContent = "🔄 Конвертировать подзадачи";
      return;
    }

    const projectKey = issue.fields.project.key;
    const targetTypeId = await getStandardIssueTypeId(projectKey);

    const convertedKeys = [];
    for (const subtask of targets) {
      await convertSubtaskToIssue(subtask.key, targetTypeId);
      await createRelatesLink(subtask.key, issueKey);
      convertedKeys.push(subtask.key);
    }

    showNotification(`Сконвертированы и связаны: ${convertedKeys.join(", ")}`, "success");
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    showNotification(e.message, "error");
    button.disabled = false;
    button.textContent = "🔄 Конвертировать подзадачи";
  }
}

/* -----------------------------
   Добавление кнопок на страницу
------------------------------*/
function addButtons() {
  const issueKey = getCurrentIssueKey();
  if (!issueKey) return;

  if (document.querySelector(".jira-qa-helper-buttons")) return;

  const header = document.querySelector('[data-testid="issue.views.issue-base.foundation.summary.heading"]')
    || document.querySelector('#summary-val')
    || document.querySelector('h1[id^="summary"]');

  if (!header) return;

  const box = document.createElement("div");
  box.className = "jira-qa-helper-buttons";

  const btnCreate = document.createElement("button");
  btnCreate.className = "jira-qa-helper-button jira-qa-helper-button-create";
  btnCreate.textContent = "➕ Создать QA подзадачи";
  btnCreate.onclick = () => createQASubtasks(btnCreate);

  const btnConvert = document.createElement("button");
  btnConvert.className = "jira-qa-helper-button jira-qa-helper-button-convert";
  btnConvert.textContent = "🔄 Конвертировать подзадачи";
  btnConvert.onclick = () => convertQASubtasks(btnConvert);

  box.appendChild(btnCreate);
  box.appendChild(btnConvert);
  header.parentElement.insertBefore(box, header.nextSibling);
}

/* -----------------------------
   Инициализация
------------------------------*/
function init() {
  addButtons();

  new MutationObserver(addButtons).observe(document.body, {
    childList: true,
    subtree: true
  });

  let last = location.href;
  new MutationObserver(() => {
    if (location.href !== last) {
      last = location.href;
      setTimeout(addButtons, 400);
    }
  }).observe(document, { subtree: true, childList: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
