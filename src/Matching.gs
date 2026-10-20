/**
 * Matching.gs — the job-matching domain: what to ask the LLM, how to read
 * its answer, and how to work through a list of jobs. No sheet or vendor code.
 */

/** Builds the system and user prompts for one job. */
class MatchPromptBuilder {
  constructor(todayIso) { this.today_ = todayIso; }

  build(job, resume) {
    return { system: this.system_(), user: this.user_(job, resume) };
  }

  system_() {
    return [
      'You are an experienced technical recruiter in Malaysia screening a candidate for a job.',
      'Compare the candidate\'s resume with the job description strictly and honestly.',
      'Today is ' + this.today_ + '. Work out years of experience from the dates on the resume.',
      'Only credit skills and experience the resume actually shows. Never invent experience.',
      '',
      'Choose exactly one verdict:',
      '- "' + VERDICTS.shouldApply + '": meets most must-have requirements; any gaps are minor, preferred-only, or quickly learnable.',
      '- "' + VERDICTS.stretch + '": meets the core of the role but misses one or two must-haves (for example slightly fewer years than asked, a degree outside the listed fields, one key technology missing). Worth applying with a tailored resume.',
      '- "' + VERDICTS.cannotApply + '": fails a hard eligibility requirement (citizenship, required licence or certification, mandatory language exam), falls far short of the required years (for example asks 5+ and candidate has 2), or the role is a different discipline altogether.',
      '',
      'Respond with ONLY a JSON object, no markdown, in this exact shape:',
      '{',
      '  "verdict": "' + VERDICTS.shouldApply + '" | "' + VERDICTS.stretch + '" | "' + VERDICTS.cannotApply + '",',
      '  "score": integer 0-100 (how well the resume matches),',
      '  "summary": "2-3 sentences explaining the verdict",',
      '  "matched": ["requirement the candidate clearly meets", ...],',
      '  "gaps": ["must-have or important requirement the resume does not show", ...],',
      '  "dealbreakers": ["hard requirement that rules the candidate out", ...] (empty if none),',
      '  "resume_tips": ["specific, honest change to the resume for this job", ...] (max 3)',
      '}',
    ].join('\n');
  }

  user_(job, resume) {
    return [
      '## JOB',
      'Company: ' + job.company,
      'Location: ' + job.location + (job.workMode ? ' (' + job.workMode + ')' : ''),
      'URL: ' + job.url,
      '',
      job.description,
      '',
      '## CANDIDATE RESUME',
      resume,
    ].join('\n');
  }
}

/** Turns the model's text reply into a MatchResult. */
class MatchResultParser {
  /** @return {MatchResult} {verdict, score, summary, matched[], gaps[], dealbreakers[], tips[]} or {error} */
  parse(text) {
    try {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) throw new Error('no JSON in reply');
      const r = JSON.parse(text.slice(start, end + 1));
      return {
        verdict: MatchResultParser.normalizeVerdict(r.verdict),
        score: Math.max(0, Math.min(100, parseInt(r.score, 10) || 0)),
        summary: String(r.summary || ''),
        matched: MatchResultParser.toArray(r.matched),
        gaps: MatchResultParser.toArray(r.gaps),
        dealbreakers: MatchResultParser.toArray(r.dealbreakers),
        tips: MatchResultParser.toArray(r.resume_tips).slice(0, 3),
      };
    } catch (e) {
      return { error: 'Could not read the model\'s reply (' + e.message + '). Try again.' };
    }
  }

  static normalizeVerdict(v) {
    const s = String(v || '').toLowerCase();
    if (s.indexOf('cannot') >= 0 || s.indexOf("can't") >= 0 || s.indexOf('do not') >= 0) return VERDICTS.cannotApply;
    if (s.indexOf('stretch') >= 0) return VERDICTS.stretch;
    if (s.indexOf('should') >= 0 || s.indexOf('apply') >= 0) return VERDICTS.shouldApply;
    return VERDICTS.stretch;
  }

  static toArray(x) {
    if (!x) return [];
    return (Array.isArray(x) ? x : [x]).map(String).filter(s => s.trim());
  }
}

/** Shows progress to the user; swap for a no-op in tests or triggers. */
class ToastProgressReporter {
  constructor(spreadsheet) { this.ss_ = spreadsheet; }
  report(message, seconds) { this.ss_.toast(message, 'Job Matcher', seconds == null ? -1 : seconds); }
}

/** Orchestrates matching a list of jobs; depends only on abstractions. */
class JobMatchingService {
  /**
   * @param {{llm:LlmClient, prompts:MatchPromptBuilder, parser:MatchResultParser,
   *          results:MatchResultRepository, progress:ToastProgressReporter,
   *          providerLabel:string, model:string, clock?:{now:function():number}}} deps
   */
  constructor(deps) {
    this.d_ = deps;
    this.clock_ = deps.clock || { now: () => Date.now() };
  }

  /** @return {{done:number, failed:number, remaining:number}} */
  run(jobs, resume) {
    const { llm, prompts, parser, results, progress, providerLabel, model } = this.d_;
    const started = this.clock_.now();
    let done = 0, failed = 0;

    progress.report('Analyzing ' + jobs.length + ' job(s) with ' + providerLabel + '…');

    for (let i = 0; i < jobs.length; i += MATCHING.parallelRequests) {
      if (this.clock_.now() - started > MATCHING.maxRuntimeMs) break;

      const batch = jobs.slice(i, i + MATCHING.parallelRequests);
      const chats = batch.map(job => Object.assign(prompts.build(job, resume), {
        model: model,
        maxTokens: MATCHING.maxOutputTokens,
        temperature: MATCHING.temperature,
      }));
      const replies = llm.completeAll(chats);

      const records = batch.map((job, k) => {
        const result = replies[k].ok ? parser.parse(replies[k].text) : { error: replies[k].error };
        if (result.error) failed++; else done++;
        return { job: job, result: result, provider: providerLabel, model: model };
      });
      results.saveAll(records);
      progress.report('Analyzed ' + (done + failed) + ' of ' + jobs.length + '…');
    }

    return { done: done, failed: failed, remaining: jobs.length - done - failed };
  }
}
