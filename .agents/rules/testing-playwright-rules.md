---
# cspell:words Mindpool
description: Playwright E2E testing rules for Mindpool — locator strategy, test isolation, CI config, Page Object Model
---
# Testing Rules — Playwright

> [!IMPORTANT]
> Mindpool's E2E tests run in `deploy.yml` after deployment to GKE. Flaky or poorly isolated tests block production deploys. These rules enforce patterns from Playwright best practices to keep tests fast, deterministic, and maintainable.

## 1. Locator Priority — Role First, CSS Never

- **ALWAYS** select elements in this order: `getByRole()` → `getByLabel()` → `getByTestId()`.
- **NEVER** use CSS class selectors (`.btn-primary`) or XPath. CSS classes change during refactoring and break tests silently.
- Add `data-testid="<kebab-case-purpose>"` attributes only when no semantic role or label is available.
- Correct: `page.getByRole('button', { name: 'Create Pool' })`
- Forbidden: `page.locator('.create-btn')` or `page.locator('//div[@class="btn"]')`

## 2. No `waitForTimeout()` — Use Web-First Assertions

- **NEVER** use `page.waitForTimeout(ms)` or `await new Promise(r => setTimeout(r, ms))`. These are arbitrary sleeps that make tests slow and flaky.
- Use web-first assertions that auto-retry: `await expect(locator).toBeVisible()`, `await expect(locator).toHaveText(...)`.
- For network events: use `page.waitForResponse()` or `page.waitForRequest()` with a URL pattern.

## 3. Test Isolation — No Shared State Between Tests

- **EVERY** test must be fully independent. Never rely on state left by a previous test.
- Create required data via API calls in `beforeEach` hooks. Clean up in `afterEach` hooks.
- Tests that depend on execution order are forbidden — Playwright may run tests in parallel.

## 4. Page Object Model for Reused Pages

- **ALWAYS** create a Page Object class for any page or component that appears in more than one test file.
- Place POM classes in `e2e/pages/` with filenames like `PoolPage.ts`, `SettingsPage.ts`.
- POM methods encapsulate user interactions: `poolPage.createPool(topic)` not raw `page.locator(...)` chains repeated across tests.

## 5. Mock External Services — No Real Network Calls

- **NEVER** make real calls to external services (LLM APIs, email providers) in E2E tests. External service downtime must not cause test failures.
- Use `page.route('**/api/stream/**', route => route.fulfill(...))` to intercept and mock SSE streams or external API calls in tests that don't specifically test the integration.

## 6. CI Configuration — Trace and Screenshot on Failure Only

- **ALWAYS** configure `playwright.config.ts` with `trace: 'on-first-retry'` and `screenshot: 'only-on-failure'`. This provides diagnostic artifacts without bloating every CI run.
- Upload the `playwright-report/` directory as a CI artifact so failed test traces are available for debugging.
- Do not set `trace: 'on'` globally — it significantly increases run time and storage.

## 7. Test Names Describe User Behavior

- **ALWAYS** name tests to complete the sentence "User can...". Test names must describe behavior, not implementation.
- Group with `test.describe()` by user flow, not by file or component name.
- Correct: `test.describe('Pool creation flow') { test('User can create a pool with a topic', ...) }`
- Forbidden: `test.describe('PoolForm') { test('renders correctly', ...) }`

## 8. No UI Authentication in Non-Auth Tests

- **NEVER** log in via the UI in tests that are not specifically testing the authentication flow. UI login is slow and creates coupling.
- Use Playwright's `storageState` to inject authenticated session state, or make a direct `request.post('/api/auth/login')` call in `beforeEach` and store the token.
