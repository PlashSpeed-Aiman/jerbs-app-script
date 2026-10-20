/**
 * Llm.gs — provider-agnostic LLM layer.
 *
 * SOLID notes
 *  - S: each provider only knows how to talk to its own API; LlmClient only
 *       runs requests; nothing here knows about jobs or sheets.
 *  - O: add a provider by writing a class and registering it in
 *       createProviderRegistry_(); no existing class changes.
 *  - L: every provider honours the same contract (see LlmProvider), so the
 *       client and services can use any of them interchangeably.
 *  - I: the contract is small: build/parse a chat request, build/parse a
 *       model listing.
 *  - D: LlmClient depends on an injected HttpClient and an LlmProvider, not on
 *       UrlFetchApp or a concrete vendor.
 *
 * A chat request is: { system: string, user: string, model: string,
 *                      maxTokens?: number, temperature?: number }
 * A completion is:   { ok: true, text: string } | { ok: false, error: string }
 */

class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'LlmError';
    this.status = status || 0;
  }
}

/** Thin wrapper over UrlFetchApp so it can be swapped out in tests. */
class UrlFetchHttpClient {
  fetch(request) {
    return UrlFetchApp.fetch(request.url, request);
  }
  fetchAll(requests) {
    return UrlFetchApp.fetchAll(requests);
  }
}

/** Contract every provider implements. */
class LlmProvider {
  /** @return {string} stable id, e.g. "openai" */
  get id() { throw new Error('not implemented'); }
  /** @return {string} label shown in the UI */
  get label() { throw new Error('not implemented'); }
  /** @return {string} model used when none is chosen */
  get defaultModel() { return ''; }
  /** @return {object} UrlFetchApp request params */
  buildChatRequest(chat, apiKey) { throw new Error('not implemented'); }
  /** @return {string} the reply text; throws LlmError on failure */
  parseChatResponse(status, body) { throw new Error('not implemented'); }
  /** @return {object} UrlFetchApp request params */
  buildListModelsRequest(apiKey) { throw new Error('not implemented'); }
  /** @return {string[]} model ids */
  parseListModelsResponse(status, body) { throw new Error('not implemented'); }

  // Shared helper: turn an HTTP error body into a readable LlmError.
  static errorFrom(status, body) {
    let msg = body;
    try {
      const j = JSON.parse(body);
      msg = (j.error && (j.error.message || j.error)) || j.message || body;
    } catch (e) { /* keep raw body */ }
    return new LlmError('API error ' + status + ': ' + String(msg).slice(0, 300), status);
  }
}

/** Any API that speaks the OpenAI Chat Completions format. */
class OpenAiCompatibleProvider extends LlmProvider {
  /**
   * @param {{id:string,label:string,baseUrl:string,defaultModel?:string,
   *          extraHeaders?:object,sendTemperature?:boolean}} opts
   */
  constructor(opts) {
    super();
    this.opts_ = Object.assign({ extraHeaders: {}, sendTemperature: true, defaultModel: '' }, opts);
  }
  get id() { return this.opts_.id; }
  get label() { return this.opts_.label; }
  get defaultModel() { return this.opts_.defaultModel; }

  headers_(apiKey) {
    return Object.assign({ Authorization: 'Bearer ' + apiKey }, this.opts_.extraHeaders);
  }

  buildChatRequest(chat, apiKey) {
    const body = {
      model: chat.model,
      messages: [
        { role: 'system', content: chat.system },
        { role: 'user', content: chat.user },
      ],
    };
    if (this.opts_.sendTemperature && chat.temperature != null) body.temperature = chat.temperature;
    return {
      url: this.opts_.baseUrl + '/chat/completions',
      method: 'post',
      contentType: 'application/json',
      headers: this.headers_(apiKey),
      muteHttpExceptions: true,
      payload: JSON.stringify(body),
    };
  }

  parseChatResponse(status, body) {
    if (status !== 200) throw LlmProvider.errorFrom(status, body);
    const j = JSON.parse(body);
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    if (!msg || typeof msg.content !== 'string') throw new LlmError('Empty reply from model');
    return msg.content;
  }

  buildListModelsRequest(apiKey) {
    return {
      url: this.opts_.baseUrl + '/models',
      method: 'get',
      headers: this.headers_(apiKey),
      muteHttpExceptions: true,
    };
  }

  parseListModelsResponse(status, body) {
    if (status !== 200) throw LlmProvider.errorFrom(status, body);
    return (JSON.parse(body).data || []).map(m => m.id).sort();
  }
}

/** Anthropic Messages API. */
class AnthropicProvider extends LlmProvider {
  constructor(opts) {
    super();
    this.opts_ = Object.assign({
      baseUrl: 'https://api.anthropic.com/v1',
      apiVersion: '2023-06-01',
      defaultModel: 'claude-haiku-5-5',
    }, opts || {});
  }
  get id() { return 'anthropic'; }
  get label() { return 'Anthropic (Claude)'; }
  get defaultModel() { return this.opts_.defaultModel; }

  headers_(apiKey) {
    return { 'x-api-key': apiKey, 'anthropic-version': this.opts_.apiVersion };
  }

  buildChatRequest(chat, apiKey) {
    const body = {
      model: chat.model,
      max_tokens: chat.maxTokens || 1500,
      system: chat.system,
      messages: [{ role: 'user', content: chat.user }],
    };
    if (chat.temperature != null) body.temperature = chat.temperature;
    return {
      url: this.opts_.baseUrl + '/messages',
      method: 'post',
      contentType: 'application/json',
      headers: this.headers_(apiKey),
      muteHttpExceptions: true,
      payload: JSON.stringify(body),
    };
  }

  parseChatResponse(status, body) {
    if (status !== 200) throw LlmProvider.errorFrom(status, body);
    const j = JSON.parse(body);
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (!text) throw new LlmError('Empty reply from model');
    return text;
  }

  buildListModelsRequest(apiKey) {
    return {
      url: this.opts_.baseUrl + '/models?limit=100',
      method: 'get',
      headers: this.headers_(apiKey),
      muteHttpExceptions: true,
    };
  }

  parseListModelsResponse(status, body) {
    if (status !== 200) throw LlmProvider.errorFrom(status, body);
    return (JSON.parse(body).data || []).map(m => m.id);
  }
}

/** Keeps the available providers; the only place that knows them all. */
class ProviderRegistry {
  constructor() { this.providers_ = {}; }
  register(provider) { this.providers_[provider.id] = provider; return this; }
  get(id) {
    const p = this.providers_[id];
    if (!p) throw new Error('Unknown LLM provider: ' + id);
    return p;
  }
  list() {
    return Object.keys(this.providers_).map(id => {
      const p = this.providers_[id];
      return { id: p.id, label: p.label, defaultModel: p.defaultModel };
    });
  }
}

/** Add or remove providers here. */
function createProviderRegistry_() {
  return new ProviderRegistry()
    .register(new OpenAiCompatibleProvider({
      id: 'deepseek',
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-chat',
    }))
    .register(new OpenAiCompatibleProvider({
      id: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      // Some newer OpenAI models reject a custom temperature, so leave it out.
      sendTemperature: false,
    }))
    .register(new OpenAiCompatibleProvider({
      id: 'openrouter',
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'deepseek/deepseek-chat',
      extraHeaders: { 'X-Title': 'Job Matcher (Google Sheets)' },
    }))
    .register(new AnthropicProvider());
}

/** Runs chat requests against one provider, in parallel. */
class LlmClient {
  /**
   * @param {LlmProvider} provider
   * @param {string} apiKey
   * @param {UrlFetchHttpClient} http
   */
  constructor(provider, apiKey, http) {
    if (!apiKey) throw new Error('No API key saved for ' + provider.label + '. Open Job Matcher > Settings.');
    this.provider_ = provider;
    this.apiKey_ = apiKey;
    this.http_ = http;
  }

  /** @return {{ok:boolean,text?:string,error?:string}[]} one result per chat, same order */
  completeAll(chats) {
    const requests = chats.map(c => this.provider_.buildChatRequest(c, this.apiKey_));
    const responses = this.http_.fetchAll(requests);
    return responses.map(res => {
      try {
        return { ok: true, text: this.provider_.parseChatResponse(res.getResponseCode(), res.getContentText()) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
  }

  listModels() {
    const res = this.http_.fetch(this.provider_.buildListModelsRequest(this.apiKey_));
    return this.provider_.parseListModelsResponse(res.getResponseCode(), res.getContentText());
  }
}
