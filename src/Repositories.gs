/**
 * Repositories.gs — everything that reads or writes storage.
 * Each class owns one store, so sheet layout changes stay in one place.
 */

/** API keys (private, per Google user) and per-spreadsheet settings. */
class SettingsStore {
  constructor(userProps, docProps) {
    this.user_ = userProps;
    this.doc_ = docProps;
  }
  getApiKey(providerId) { return this.user_.getProperty('API_KEY_' + providerId) || ''; }
  setApiKey(providerId, key) { this.user_.setProperty('API_KEY_' + providerId, key); }
  hasApiKey(providerId) { return !!this.getApiKey(providerId); }

  getProviderId() { return this.doc_.getProperty('PROVIDER') || 'deepseek'; }
  setProviderId(id) { this.doc_.setProperty('PROVIDER', id); }

  getModel(providerId) { return this.doc_.getProperty('MODEL_' + providerId) || ''; }
  setModel(providerId, model) { this.doc_.setProperty('MODEL_' + providerId, model); }

  getSourceSheetName() { return this.doc_.getProperty('SOURCE_SHEET') || ''; }
  setSourceSheetName(name) { this.doc_.setProperty('SOURCE_SHEET', name); }
}

/** Resume text in a hidden sheet (properties are too small for a full resume). */
class ResumeRepository {
  constructor(spreadsheet) { this.ss_ = spreadsheet; }
  get() {
    const sh = this.ss_.getSheetByName(SHEET_NAMES.resume);
    return sh ? String(sh.getRange('A1').getValue() || '') : '';
  }
  save(text) {
    let sh = this.ss_.getSheetByName(SHEET_NAMES.resume);
    if (!sh) {
      sh = this.ss_.insertSheet(SHEET_NAMES.resume);
      sh.hideSheet();
    }
    sh.getRange('A1').setValue(text);
  }
}

/** Reads job postings from the sheet the capture extension writes to. */
class JobRepository {
  constructor(spreadsheet, settings) {
    this.ss_ = spreadsheet;
    this.settings_ = settings;
  }

  candidateSheetNames() {
    const reserved = [SHEET_NAMES.results, SHEET_NAMES.resume];
    return this.ss_.getSheets().map(s => s.getName()).filter(n => reserved.indexOf(n) < 0);
  }

  sheet() {
    const name = this.settings_.getSourceSheetName();
    const sh = (name && this.ss_.getSheetByName(name)) ||
      this.ss_.getSheetByName(this.candidateSheetNames()[0] || '');
    if (!sh) throw new Error('No job sheet found.');
    return sh;
  }

  /** @return {Job[]} valid job rows; skips test rows and blanks */
  findAll() {
    const sh = this.sheet();
    const last = sh.getLastRow();
    if (last < 1) return [];
    const c = JOB_COLUMNS;
    return sh.getRange(1, 1, last, c.description).getValues()
      .map((r, i) => ({ r: r, row: i + 1 }))
      .filter(x => /^https?:\/\//i.test(String(x.r[c.url - 1] || '')) &&
                   String(x.r[c.description - 1] || '').trim().length >= 50)
      .map(x => {
        const jobId = String(x.r[c.jobId - 1] || '').trim();
        const url = String(x.r[c.url - 1]);
        return {
          row: x.row,
          key: jobId || url,
          jobId: jobId,
          url: url,
          workMode: String(x.r[c.workMode - 1] || ''),
          company: String(x.r[c.company - 1] || ''),
          location: String(x.r[c.location - 1] || ''),
          description: String(x.r[c.description - 1]).trim().slice(0, MATCHING.maxJobDescriptionChars),
        };
      });
  }

  findByRows(rowNumbers) {
    const wanted = new Set(rowNumbers);
    return this.findAll().filter(j => wanted.has(j.row));
  }
}

/** The "Matches" sheet: one row per job, upserted by job key. */
class MatchResultRepository {
  constructor(spreadsheet) { this.ss_ = spreadsheet; }

  /** @return {Set<string>} keys of jobs that already have a non-error result */
  analyzedKeys() {
    const keys = new Set();
    this.rows_().forEach(r => { if (r.verdict !== VERDICTS.error) keys.add(r.key); });
    return keys;
  }

  /** @param {{job:Job, result:MatchResult, provider:string, model:string}[]} records */
  saveAll(records) {
    if (!records.length) return;
    const sh = this.ensureSheet_();
    const index = {};
    this.rows_().forEach(r => { index[r.key] = r.rowNumber; });
    let next = sh.getLastRow() + 1;
    records.forEach(rec => {
      const target = index[rec.job.key] || next++;
      index[rec.job.key] = target;
      sh.getRange(target, 1, 1, RESULT_HEADERS.length).setValues([this.toRow_(rec)]);
    });
  }

  clear() {
    const sh = this.ss_.getSheetByName(SHEET_NAMES.results);
    if (sh && sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, RESULT_HEADERS.length).clearContent();
    }
  }

  activate() { this.ensureSheet_().activate(); }

  // ---- private

  rows_() {
    const sh = this.ss_.getSheetByName(SHEET_NAMES.results);
    if (!sh || sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().map((r, i) => ({
      rowNumber: i + 2,
      key: String(r[0] || r[4] || ''),
      verdict: r[5],
    })).filter(r => r.key);
  }

  toRow_(rec) {
    const r = rec.result;
    const list = arr => (arr || []).map(s => '• ' + s).join('\n');
    const failed = !!r.error;
    return [
      rec.job.jobId, rec.job.company, rec.job.location, rec.job.workMode, rec.job.url,
      failed ? VERDICTS.error : r.verdict,
      failed ? '' : r.score,
      failed ? r.error : r.summary,
      failed ? '' : list(r.matched),
      failed ? '' : list(r.gaps),
      failed ? '' : list(r.dealbreakers),
      failed ? '' : list(r.tips),
      new Date(),
      rec.provider,
      rec.model,
    ];
  }

  ensureSheet_() {
    let sh = this.ss_.getSheetByName(SHEET_NAMES.results);
    if (sh) return sh;
    sh = this.ss_.insertSheet(SHEET_NAMES.results);
    sh.getRange(1, 1, 1, RESULT_HEADERS.length).setValues([RESULT_HEADERS.slice()])
      .setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
    [90, 170, 160, 80, 180, 110, 90, 360, 300, 300, 240, 300, 140, 100, 140]
      .forEach((w, i) => sh.setColumnWidth(i + 1, w));
    sh.getRange('A2:O').setVerticalAlignment('top').setWrap(true);
    sh.getRange('E2:E').setWrap(false);
    const verdictRange = sh.getRange('F2:F');
    sh.setConditionalFormatRules([
      [VERDICTS.shouldApply, '#d9ead3', '#274e13'],
      [VERDICTS.stretch, '#fff2cc', '#7f6000'],
      [VERDICTS.cannotApply, '#f4cccc', '#990000'],
      [VERDICTS.error, '#efefef', '#666666'],
    ].map(([text, bg, fg]) => SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(text).setBackground(bg).setFontColor(fg).setBold(true)
      .setRanges([verdictRange]).build()));
    return sh;
  }
}
