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
const ISSUE_KEY_REGEX = /([A-Z0-9]+-\d+)/;

function detectIssueKey() {
  const { href, pathname, hash } = window.location;

  const browseMatch = pathname.match(/\/browse\/([A-Z0-9]+-\d+)(?=\/|$)/);
  if (browseMatch) return { key: browseMatch[1] };

  const issuesMatch = pathname.match(/\/issues\/([A-Z0-9]+-\d+)(?=\/|$)/);
  if (issuesMatch) return { key: issuesMatch[1] };

  const hashMatch = (hash || "").match(ISSUE_KEY_REGEX);
  if (hashMatch) return { key: hashMatch[1] };

  const pathMatches = Array.from(new Set(
    pathname
      .split("/")
      .filter(Boolean)
      .map(segment => {
        const match = segment.match(ISSUE_KEY_REGEX);
        return match ? match[1] : null;
      })
      .filter(Boolean)
  ));

  if (pathMatches.length === 1) return { key: pathMatches[0] };
  if (pathMatches.length > 1) {
    return { key: null, error: "Найдено несколько возможных ключей задачи в URL" };
  }

  const urlMatches = Array.from(
    new Set(href.match(new RegExp(ISSUE_KEY_REGEX.source, "g")) || [])
  );

  if (urlMatches.length === 1) return { key: urlMatches[0] };
  if (urlMatches.length > 1) {
    return { key: null, error: "Найдено несколько возможных ключей задачи в URL" };
  }

  return { key: null, error: "Не удалось определить ключ задачи" };
}

function getCurrentIssueKey(options = {}) {
  const { notify = false } = options;
  const { key, error } = detectIssueKey();

  if (!key && notify) {
    notifyIssueKeyError(error);
  }

  return key;
}

let lastIssueKeyError = null;
let lastIssueKeyErrorHref = null;

function notifyIssueKeyError(error) {
  if (!error) return;

  const currentHref = window.location.href;
  const alreadyShown = lastIssueKeyError === error && lastIssueKeyErrorHref === currentHref;

  if (!alreadyShown) {
    showNotification(error, "error");
    console.warn(`[Jira QA Helper] ${error}`);
    lastIssueKeyError = error;
    lastIssueKeyErrorHref = currentHref;
  }
}

const TARGET_SUBTASKS = [
  { title: "Тестирование", prefix: "[Тестирование]" },
  { title: "Документация", prefix: "[Документация]" }
];

/* -----------------------------
   Получение данных задачи
------------------------------*/
async function getIssueData(issueKey) {
  const baseUrl = getJiraBaseUrl();

  const response = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}?fields=summary,project,subtasks`, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    credentials: 'include'
  });

  if (!response.ok) {
    throw new Error(`Ошибка получения данных задачи: ${response.status} - ${await response.text()}`);
  }

  return await response.json();
}

function splitExistingAndMissing(subtasks, targets) {
  const existing = [];
  const missing = [];

  targets.forEach(target => {
    const found = subtasks.find(st => {
      const summary = st.fields?.summary || st.summary || "";
      return summary.startsWith(`${target.prefix} `);
    });
    if (found) {
      existing.push({ ...target, key: found.key || found.id });
    } else {
      missing.push(target);
    }
  });

  return { existing, missing };
}

function buildCreationMessage(created, existing, errors) {
  const parts = [];

  if (created.length) {
    parts.push(`Созданы: ${created.map(c => `${c.title} (${c.key})`).join(", ")}`);
  }

  if (existing.length) {
    parts.push(`Пропущены (уже есть): ${existing.map(e => `${e.title} (${e.key})`).join(", ")}`);
  }

  if (errors.length) {
    parts.push(
      `Ошибки: ${errors.map(e => `${e.title} — ${e.message}`).join("; ")}. ` +
      "Повторите создание для неуспешных или удалите созданные подзадачи перед повтором."
    );
  }

  return parts.join(". ");
}

function filterSubtasksByTargets(subtasks, targets) {
  return subtasks.filter(st => {
    const summary = st.fields?.summary || st.summary || "";
    return targets.some(t => summary.startsWith(t.prefix));
  });
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
async function createSubtask(parentKey, summary, issueTypeId, projectId, assignee) {
  const baseUrl = getJiraBaseUrl();

  const payload = {
    fields: {
      project: { id: projectId },
      parent: { key: parentKey },
      summary: summary,
      issuetype: { id: issueTypeId },
      assignee
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
   Определение режима (Cloud/Server/DC)
------------------------------*/
let deploymentTypeCache = null;

async function getDeploymentType() {
  if (deploymentTypeCache) return deploymentTypeCache;

  const baseUrl = getJiraBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/rest/api/3/serverInfo`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }

    const data = await response.json();
    deploymentTypeCache = data?.deploymentType?.toLowerCase() || 'unknown';
  } catch (e) {
    deploymentTypeCache = 'unknown';
  }

  return deploymentTypeCache;
}

/* -----------------------------
   Подготовка ассайни для разных режимов
------------------------------*/
function buildAssigneeField(user, deploymentType) {
  if (deploymentType === 'cloud' && user.accountId) {
    return { accountId: user.accountId };
  }

  if ((deploymentType === 'server' || deploymentType === 'datacenter') && user.name) {
    return { name: user.name };
  }

  if ((deploymentType === 'server' || deploymentType === 'datacenter') && user.key) {
    return { key: user.key };
  }

  if (user.accountId) return { accountId: user.accountId };
  if (user.name) return { name: user.name };
  if (user.key) return { key: user.key };

  throw new Error('Не удалось определить исполнителя для подзадачи');
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

  const qaType = nonSubtaskTypes.find(t => t.name.trim().toLowerCase() === "qa");
  if (qaType) return qaType.id;

  const taskType = nonSubtaskTypes.find(t => t.name.trim().toLowerCase() === "task");
  return (taskType || nonSubtaskTypes[0]).id;
}

/* -----------------------------
   Создание QA-подзадач с назначением текущего пользователя
------------------------------*/
async function createQASubtasks(button) {
  const { key: issueKey, error: issueKeyError } = detectIssueKey();
  if (!issueKey) {
    notifyIssueKeyError(issueKeyError);
    return;
  }

  const defaultButtonText = "➕ Создать QA подзадачи";
  button.disabled = true;
  button.textContent = "Создание...";

  try {
    const issue = await getIssueData(issueKey);
    const summary = issue.fields.summary;
    const projectId = issue.fields.project.id;
    const projectKey = issue.fields.project.key;
    const subtasks = issue.fields.subtasks || [];

    const qaType = await getQASubtaskTypeId(projectKey);
    const currentUser = await getCurrentUser();
    const deploymentType = await getDeploymentType();
    const assignee = buildAssigneeField(currentUser, deploymentType);

    const { existing, missing } = splitExistingAndMissing(subtasks, TARGET_SUBTASKS);
    const created = [];
    const errors = [];

    for (const target of missing) {
      try {
        const result = await createSubtask(
          issueKey,
          `${target.prefix} ${summary}`,
          qaType,
          projectId,
          assignee
        );
        created.push({ ...target, key: result.key || result.id });
      } catch (e) {
        errors.push({ ...target, message: e.message });
      }
    }

    const message = buildCreationMessage(created, existing, errors);

    if (errors.length) {
      showNotification(message, "warning");
      button.disabled = false;
      button.textContent = defaultButtonText;
      return;
    }

    const finalMessage = message || "Нет действий: подзадачи не были созданы.";
    showNotification(finalMessage, existing.length ? "info" : "success");

    if (created.length) {
      setTimeout(() => location.reload(), 1500);
    } else {
      button.disabled = false;
      button.textContent = defaultButtonText;
    }

  } catch (e) {
    showNotification(e.message, "error");
    button.disabled = false;
    button.textContent = defaultButtonText;
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

  const response = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}/issueType`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      issueTypeId: targetIssueTypeId
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
  const { key: issueKey, error: issueKeyError } = detectIssueKey();
  if (!issueKey) {
    notifyIssueKeyError(issueKeyError);
    return;
  }

  lastIssueKeyError = null;
  lastIssueKeyErrorHref = null;

  if (document.querySelector(".jira-qa-helper-buttons")) return;

  const header = document.querySelector('[role="heading"][data-testid="issue.views.issue-base.foundation.summary.heading"]')
    || document.querySelector('[data-testid="issue.views.issue-base.foundation.summary.heading"]')
    || document.querySelector('[role="heading"][data-testid*="summary"]')
    || document.querySelector('[role="heading"][aria-level="1"]')
    || document.querySelector('#summary-val')
    || document.querySelector('h1[id^="summary"]');

  if (!header || !header.parentElement) return;

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
  let lastHref = location.href;

  addButtons();

  new MutationObserver(() => {
    const currentHref = location.href;

    if (currentHref !== lastHref) {
      lastHref = currentHref;
      setTimeout(addButtons, 400);
    }

    addButtons();
  }).observe(document.body, {
    childList: true,
    subtree: true
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
