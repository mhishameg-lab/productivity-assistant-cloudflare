import { createGoogleAccessTokenProvider } from "./google-oauth.js";

const GOOGLE_TASKS_API = "https://tasks.googleapis.com/tasks/v1";

export function createGoogleTasksClient(env, fetchImpl = fetch, clock = () => Date.now()) {
  const required = [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REFRESH_TOKEN",
    "GOOGLE_TASK_LIST_ID"
  ];
  const missing = required.filter(key => !env[key]);
  if (missing.length) {
    throw new Error(`Google Tasks integration is not configured (${missing.join(", ")}).`);
  }

  const accessToken = createGoogleAccessTokenProvider(env, fetchImpl, clock);

  async function request(path, options = {}) {
    const token = await accessToken();
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetchImpl(`${GOOGLE_TASKS_API}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.headers || {})
        }
      });
      if (response.status < 500 && response.status !== 429) break;
      if (attempt < 2) await delay(250 * (2 ** attempt));
    }
    if (!response.ok) {
      const error = new Error(`Google Tasks API request failed with HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }

  return {
    async listAll() {
      const tasks = [];
      let pageToken = "";
      do {
        const query = new URLSearchParams({
          showCompleted: "true",
          showHidden: "true",
          showDeleted: "true",
          maxResults: "100"
        });
        if (pageToken) query.set("pageToken", pageToken);
        const page = await request(
          `/lists/${encodeURIComponent(env.GOOGLE_TASK_LIST_ID)}/tasks?${query}`
        );
        tasks.push(...(page.items || []));
        pageToken = page.nextPageToken || "";
      } while (pageToken);
      return tasks;
    },

    async complete(taskId) {
      return request(
        `/lists/${encodeURIComponent(env.GOOGLE_TASK_LIST_ID)}/tasks/${encodeURIComponent(taskId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "completed" })
        }
      );
    },

    async reschedule(taskId, dueDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate))) {
        throw new TypeError("Google Task due date must be YYYY-MM-DD.");
      }
      const date = new Date(`${dueDate}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dueDate) {
        throw new TypeError("Google Task due date is invalid.");
      }
      return request(
        `/lists/${encodeURIComponent(env.GOOGLE_TASK_LIST_ID)}/tasks/${encodeURIComponent(taskId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ due: `${dueDate}T00:00:00.000Z` })
        }
      );
    },

    async create(title, notes, dueDate) {
      const task = { title, notes };
      if (dueDate) task.due = `${dueDate}T00:00:00.000Z`;
      return request(`/lists/${encodeURIComponent(env.GOOGLE_TASK_LIST_ID)}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(task)
      });
    }
  };
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
