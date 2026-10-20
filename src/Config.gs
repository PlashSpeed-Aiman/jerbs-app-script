/**
 * Config.gs — constants only. Change behaviour here without touching logic.
 */

/** Column layout of the job sheet written by the Sheet Capture extension (1-based). */
const JOB_COLUMNS = Object.freeze({
  capturedAt: 1,
  url: 2,
  jobId: 3,
  workMode: 4,
  company: 5,
  location: 6,
  description: 7,
});

const SHEET_NAMES = Object.freeze({
  results: 'Matches',
  resume: '_Resume', // hidden; holds the resume text in A1
});

const MATCHING = Object.freeze({
  parallelRequests: 5,          // jobs sent to the LLM at the same time
  maxRuntimeMs: 5 * 60 * 1000,  // stop before Apps Script's 6-minute limit
  maxJobDescriptionChars: 12000,
  maxOutputTokens: 1500,
  temperature: 0.2,
});

const RESULT_HEADERS = Object.freeze([
  'Job ID', 'Company', 'Location', 'Work mode', 'URL',
  'Verdict', 'Match score', 'Summary', 'Matched requirements',
  'Gaps', 'Dealbreakers', 'Resume tips', 'Analyzed at', 'Provider', 'Model',
]);

const VERDICTS = Object.freeze({
  shouldApply: 'Should apply',
  stretch: 'Stretch',
  cannotApply: 'Cannot apply',
  error: 'Error',
});
