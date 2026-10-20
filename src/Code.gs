/**
 * Job Matcher for Google Sheets
 * ------------------------------------------------------------
 * Checks each captured job description against your resume with the LLM of
 * your choice (DeepSeek, OpenAI, OpenRouter or Anthropic) and writes a verdict
 * (Should apply / Stretch / Cannot apply) and summary into a "Matches" sheet.
 *
 * Files: Config.gs, Llm.gs, Repositories.gs, Matching.gs, Code.gs, Sidebar.html
 *
 * Code.gs is the composition root: menu handlers and the functions the
 * sidebar calls. It wires the pieces together and holds no business logic.
 */

// ------------------------------------------------------------------ Composition root

function createApp_() {
  const ss = SpreadsheetApp.getActive();
  const settings = new SettingsStore(
    PropertiesService.getUserProperties(),
    PropertiesService.getDocumentProperties());
  return {
    ss: ss,
    settings: settings,
    providers: createProviderRegistry_(),
    http: new UrlFetchHttpClient(),
    resume: new ResumeRepository(ss),
    jobs: new JobRepository(ss, settings),
    results: new MatchResultRepository(ss),
    progress: new ToastProgressReporter(ss),
  };
}

function createLlmClient_(app, providerId, apiKeyOverride) {
  const provider = app.providers.get(providerId);
  const key = (apiKeyOverride && apiKeyOverride.trim()) || app.settings.getApiKey(providerId);
  return { provider: provider, client: new LlmClient(provider, key, app.http) };
}

function createMatchingService_(app) {
  const providerId = app.settings.getProviderId();
  const { provider, client } = createLlmClient_(app, providerId);
  const model = app.settings.getModel(providerId) || provider.defaultModel;
  if (!model) throw new Error('No model chosen for ' + provider.label + '. Open Job Matcher > Settings and click "Load".');
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return new JobMatchingService({
    llm: client,
    prompts: new MatchPromptBuilder(today),
    parser: new MatchResultParser(),
    results: app.results,
    progress: app.progress,
    providerLabel: provider.label,
    model: model,
  });
}

// ------------------------------------------------------------------ Menu

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Job Matcher')
    .addItem('Settings (AI provider, resume)…', 'showSettings')
    .addSeparator()
    .addItem('Analyze new jobs', 'analyzeNewJobs')
    .addItem('Analyze selected rows', 'analyzeSelectedRows')
    .addItem('Re-analyze all jobs', 'reanalyzeAllJobs')
    .addSeparator()
    .addItem('Clear results', 'clearResults')
    .addToUi();
}

function showSettings() {
  SpreadsheetApp.getUi().showSidebar(
    HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('Job Matcher settings'));
}

function analyzeNewJobs() {
  const app = createApp_();
  const seen = app.results.analyzedKeys();
  runMatching_(app, app.jobs.findAll().filter(j => !seen.has(j.key)), 'new');
}

function analyzeSelectedRows() {
  const app = createApp_();
  const sourceSheet = app.jobs.sheet();
  const active = app.ss.getActiveSheet();
  if (active.getName() !== sourceSheet.getName()) {
    SpreadsheetApp.getUi().alert('Select rows on your job sheet ("' + sourceSheet.getName() + '") first.');
    return;
  }
  const rows = [];
  const list = active.getActiveRangeList();
  (list ? list.getRanges() : [active.getActiveRange()]).forEach(r => {
    for (let i = 0; i < r.getNumRows(); i++) rows.push(r.getRow() + i);
  });
  runMatching_(app, app.jobs.findByRows(rows), 'selected');
}

function reanalyzeAllJobs() {
  const app = createApp_();
  const jobs = app.jobs.findAll();
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert('Re-analyze all jobs?',
    'This sends all ' + jobs.length + ' jobs to the AI again and overwrites their results.',
    ui.ButtonSet.OK_CANCEL);
  if (answer === ui.Button.OK) runMatching_(app, jobs, 'all');
}

function clearResults() {
  const app = createApp_();
  app.results.clear();
  app.progress.report('Results cleared.', 5);
}

function runMatching_(app, jobs, label) {
  const resume = app.resume.get();
  if (!resume.trim()) {
    SpreadsheetApp.getUi().alert('No resume saved yet. Open Job Matcher > Settings and paste it in.');
    return;
  }
  if (!jobs.length) {
    app.progress.report('No ' + label + ' jobs to analyze.', 5);
    return;
  }
  let service;
  try {
    service = createMatchingService_(app);
  } catch (e) {
    SpreadsheetApp.getUi().alert(e.message);
    return;
  }
  const s = service.run(jobs, resume);

  let msg = s.done + ' analyzed';
  if (s.failed) msg += ', ' + s.failed + ' failed (see Summary column)';
  if (s.remaining) msg += '. ' + s.remaining + ' left — run "Analyze new jobs" again to continue.';
  app.progress.report(msg, 10);
  app.results.activate();
}

// ------------------------------------------------------------------ Called from Sidebar.html

function getSettings() {
  const app = createApp_();
  const providers = app.providers.list().map(p => Object.assign(p, {
    hasKey: app.settings.hasApiKey(p.id),
    model: app.settings.getModel(p.id) || p.defaultModel,
  }));
  const sheetNames = app.jobs.candidateSheetNames();
  return {
    providers: providers,
    providerId: app.settings.getProviderId(),
    sheetNames: sheetNames,
    sourceSheet: app.settings.getSourceSheetName() || sheetNames[0] || '',
    resume: app.resume.get(),
  };
}

/** @param {{providerId:string, apiKey?:string, model?:string, sourceSheet?:string, resume?:string}} form */
function saveSettings(form) {
  const app = createApp_();
  app.providers.get(form.providerId); // validates the id
  app.settings.setProviderId(form.providerId);
  if (form.apiKey && form.apiKey.trim()) app.settings.setApiKey(form.providerId, form.apiKey.trim());
  if (form.model && form.model.trim()) app.settings.setModel(form.providerId, form.model.trim());
  if (form.sourceSheet) app.settings.setSourceSheetName(form.sourceSheet);
  if (typeof form.resume === 'string') app.resume.save(form.resume);
  return 'Saved.';
}

/** Tests the key and lists the models it can use. */
function listModels(providerId, apiKey) {
  const app = createApp_();
  return createLlmClient_(app, providerId, apiKey).client.listModels();
}
