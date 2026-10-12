// The sphere's MCP tools (names, descriptions, input schemas). Two sets: `ask` for the Claude Code call behind Voice Ask (it acts
// for the user, who confirms what it queues) and `session` for the user's own Claude sessions (they talk to the user and read
// each other; anything stronger is up to the user's settings). main.js holds what each tool does; mcp_sphere.js lists them.
const str = d => ({ type: 'string', description: d });
const obj = (props, req) => ({ type: 'object', properties: props, ...(req ? { required: req } : {}) });
const SESSION = str('the session title (list_sessions shows them)');
const PC_ACTIONS = ['system_status', 'mute_mic', 'unmute_mic', 'next_output', 'next_mic', 'start_recording', 'stop_recording', 'save_replay', 'screenshot'];
const RESPONSES = ['allow', 'always_allow', 'deny', 'approve_plan', 'reject_plan'];
const MODES = ['normal', 'worker', 'night', 'weekend', 'performance', 'efficiency'];

const list_sessions = { name: 'list_sessions', description: 'The Claude sessions on the sphere: title, group, project folder, activity (working / waiting / idle), context used, and what each waiting one asks for.', inputSchema: obj({}) };
const read_session = { name: 'read_session', description: "A session's last reply and what it waits on now (a question with its options, a permission request, or a plan).", inputSchema: obj({ session: SESSION }, ['session']) };
const search_sessions = { name: 'search_sessions', description: 'Search the text of all session conversations: newest hits first, with the session title, who said it and a snippet.',
  inputSchema: obj({ text: str('words to find (at least 2 characters)'), who: { type: 'string', enum: ['user', 'assistant'], description: 'only what the user / Claude said' }, days: { type: 'number', description: 'only the last N days' } }, ['text']) };

const ask = [
  list_sessions, read_session, search_sessions,
  { name: 'open_session', description: "Show a session's conversation on screen (the wide card).", inputSchema: obj({ session: SESSION }, ['session']) },
  { name: 'new_session_form', description: 'Open the New session form on screen, optionally with a project folder picked, for the user to type the task.', inputSchema: obj({ project: str('a project folder name (see list_sessions folders); optional') }) },
  { name: 'open_file', description: "Open a file in the user's editor: a path inside a session's project folder (or a full path).", inputSchema: obj({ file: str('the file path, relative to the session folder or absolute'), session: str('the session whose folder the path is in; optional for a full path'), line: { type: 'number' } }, ['file']) },
  { name: 'ops_board', description: "The Session manager's ops board: status, tasks, critical items and more, by set. To change it, send_message to the Session manager.", inputSchema: obj({ set: str('one set only (status, tasks, critical, …); optional') }) },
  { name: 'record_until_idle', description: 'Start a screen recording now and stop it by itself when the session stops working (at most 30 minutes). Pair it with send_message to record a test run.', inputSchema: obj({ session: SESSION }, ['session']) },
  // queued: confirmed by the user after Ask's reply
  { name: 'start_session', description: 'Start a new Claude session in a project folder with a first message. Queued: the user confirms after your reply.', inputSchema: obj({ project: str('the project folder name'), task: str('the first message, as the user would type it') }, ['project', 'task']) },
  { name: 'send_message', description: 'Type a message into a session and send it, as the user. Queued: the user confirms after your reply.', inputSchema: obj({ session: SESSION, text: str('the message') }, ['session', 'text']) },
  { name: 'send_screenshot', description: 'Take a screenshot and send it to a session with a message (attached as a picture). Queued: the user confirms after your reply.', inputSchema: obj({ session: SESSION, text: str('the message to go with it') }, ['session']) },
  { name: 'respond', description: "Answer a session's permission request (allow / always_allow / deny) or its plan (approve_plan / reject_plan). Queued: the user confirms after your reply.", inputSchema: obj({ session: SESSION, response: { type: 'string', enum: RESPONSES } }, ['session', 'response']) },
  { name: 'answer_question', description: 'Answer the question(s) a session asks (read_session shows them): one entry per question, each the option labels picked, or free text in "other". Queued: the user confirms after your reply.',
    inputSchema: obj({ session: SESSION, answers: { type: 'array', items: obj({ picks: { type: 'array', items: { type: 'string' } }, other: str('free text instead of options') }) } }, ['session', 'answers']) },
  { name: 'stop_session', description: 'Interrupt what a session is doing (like pressing Esc). Queued: the user must say yes after your reply.', inputSchema: obj({ session: SESSION }, ['session']) },
  { name: 'pc', description: 'A PC action: ' + PC_ACTIONS.join(', ') + '. system_status returns the readout.', inputSchema: obj({ action: { type: 'string', enum: PC_ACTIONS } }, ['action']) },
  { name: 'set_mode', description: 'Request a PC power mode.', inputSchema: obj({ mode: { type: 'string', enum: MODES } }, ['mode']) },
];

const session = [
  { name: 'speak', description: "Say something to the user out loud through the desktop's voice (Theseus), with a caption: a finished task, a failure, a question that needs them. One or two short sentences of plain speech; use it sparingly.", inputSchema: obj({ text: str('what to say (at most about 300 characters)') }, ['text']) },
  { name: 'caption', description: 'Show a short line to the user as a caption on the sphere, without speaking.', inputSchema: obj({ text: str('the line (at most about 300 characters)') }, ['text']) },
  { name: 'needs_you', description: "Light this session's tile on the sphere as waiting on the user, with a short note why. It clears when the user opens the session or it starts working again.", inputSchema: obj({ note: str('why (a few words)') }, ['note']) },
  list_sessions, read_session, search_sessions,
  { name: 'send_message', description: 'Send a message to another session, as from this one (it arrives marked with this session\'s title). Only when the user allowed sessions to message each other in Theseus. That switch covers only this Theseus tool, never the Claude app session messaging (SendMessage).', inputSchema: obj({ session: SESSION, text: str('the message') }, ['session', 'text']) },
];

module.exports = { ask, session, PC_ACTIONS, RESPONSES, MODES };
