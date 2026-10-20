# Job Matcher

Google Sheets add-on script that checks captured job descriptions against a resume
using DeepSeek, OpenAI, OpenRouter or Anthropic.

## Files (`src/`)

| File | Role |
|---|---|
| `Code.gs` | Composition root: menu actions and sidebar functions |
| `Config.gs` | Constants: column layout, batch size, verdicts |
| `Llm.gs` | Provider contract, the four providers, `LlmClient` |
| `Repositories.gs` | Settings, resume, job sheet and Matches sheet storage |
| `Matching.gs` | Prompt builder, reply parser, `JobMatchingService` |
| `Sidebar.html` | Settings panel |
| `appsscript.json` | Apps Script manifest |

## One-time setup

1. Install Node.js 22 or newer, then: `npm install -g @google/clasp`
2. Turn on **Google Apps Script API** at https://script.google.com/home/usersettings
3. `clasp login` (opens a browser; sign in with the Google account that owns the sheet)
4. In the sheet: **Extensions → Apps Script → Project Settings (gear) → IDs → Script ID**.
   Paste it into `.clasp.json` in place of `PASTE_YOUR_SCRIPT_ID_HERE`.

## Daily use

```bash
clasp push            # upload src/ to Apps Script (replaces ALL files there)
clasp push --watch    # re-upload on every save
clasp pull            # download edits made in the online editor
clasp open-script     # open the project in the browser
```

`clasp push` replaces the whole remote project, so any file that exists only in the
online editor is deleted. Run `clasp pull` first if you've edited online.

## Git

```bash
git init
git add .
git commit -m "Job Matcher"
git remote add origin https://github.com/<you>/job-matcher.git
git push -u origin main
```

Never commit `.clasprc.json`: it holds your Google login. It is in `.gitignore`.
The script ID in `.clasp.json` is not a secret, but keep the repo private if you prefer.
