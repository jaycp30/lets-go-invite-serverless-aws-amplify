# Date Invite — Serverless AI App

A playful invite generator hosted as a static site on AWS Amplify, with an AWS Lambda backend for AI generation and calendar-invite emails.

## Project Structure

```text
invite_Claude-exercise/
├── site/                  # Static frontend
│   ├── index.html         # Invite generator form
│   ├── invite.html        # Recipient's shareable invite page
│   ├── yes.html           # Celebration page after "Yes!"
│   ├── styles.css         # Responsive CSS
│   ├── app.js             # Frontend logic
│   └── config.js          # API URL and Turnstile public sitekey, injected by Amplify
├── lambda/
│   ├── generate.js        # AI generation + SES calendar invite backend
│   └── package.json
├── amplify.yml            # Amplify static-site build spec
└── README.md
```

## Architecture

![Architecture diagram](architecture.svg)

> Source: [architecture.drawio](architecture.drawio) (open in draw.io to edit)

## How The App Works

1. The sender fills in their email, recipient name, activity, date, and optional note.
2. The frontend sends an `invite` request to API Gateway.
3. API Gateway invokes Lambda.
4. Lambda generates the content, creates an `inviteId`, and stores the private invitation record in DynamoDB.
5. The frontend shares `/invite.html?id=<inviteId>`; personal details do not appear in the URL.
6. The recipient page requests public display fields by `inviteId`, then the recipient clicks **Yes!**.
7. `/yes.html` sends only `inviteId` in its `acceptInvite` request.
8. Lambda conditionally reserves the first acceptance, sends one `.ics` calendar invite through Amazon SES, and records the invite as `SENT`.

### AI Model Roles

The application uses OpenAI's `gpt-4o-mini` as the primary generator for the personalised invitation message. Anthropic's Claude Haiku 4.5, accessed through Amazon Bedrock, supports the app's interactive experience by generating mascot copy and activity-themed animation content, while also providing a fallback for invitation-message generation if the OpenAI request is unavailable or fails.

## AWS Services In This Project

### What Is AWS Amplify?

AWS Amplify Hosting is used here as a static web host and Git-based deployment target. It watches the connected GitHub branch, runs `amplify.yml`, and publishes the files in `site/`.

In this project, Amplify does **not** manage the Lambda backend. It only builds and hosts the frontend.

### What Is API Gateway?

Amazon API Gateway is the public HTTP entry point for the backend. Browsers cannot safely call Lambda directly, so API Gateway provides a URL such as:

```text
https://abc123.execute-api.ap-northeast-1.amazonaws.com/generate
```

API Gateway receives HTTPS requests from the frontend and invokes the Lambda function behind it.

### Why Use API Gateway?

API Gateway gives the frontend a stable public API URL while Lambda stays behind an AWS-managed HTTP integration. It also handles HTTP routing, CORS preflight requests, and request forwarding to Lambda.

For this app:

```text
Frontend fetch() -> API Gateway POST /generate -> Lambda invite-generate
```

## Deployment

This project currently has two separate deployment paths:

```text
Git push -> Amplify deploys site/
Manual Lambda upload -> AWS Lambda deploys lambda/
```

This is important: changing files in `lambda/` and pushing to GitHub does **not** automatically update the live Lambda function unless a separate backend deployment pipeline is added.

For the DynamoDB invite-store release, configure the table, IAM permission, and Lambda environment variable, then deploy Lambda before publishing the matching frontend. The new frontend requires `inviteId` responses from the updated backend.

### GitHub Commits And Amplify Deployments

Amplify is connected to the GitHub repository branch. When a commit is pushed to that branch, Amplify receives the GitHub event, checks out the new commit, runs `amplify.yml`, and publishes the build artifact.

Because `amplify.yml` publishes only `site/`, any pushed commit can start an Amplify build, but only changes that affect the frontend artifact change the deployed website. Examples:

| Commit/change type | Amplify build triggered? | Live frontend changes? |
|---|---:|---:|
| `site/index.html`, `site/app.js`, `site/styles.css` | Yes | Yes |
| `amplify.yml` | Yes | Yes, build behavior may change |
| `README.md` only | Yes, unless skipped | No |
| `lambda/generate.js` only | Yes, unless skipped | No, Lambda is not deployed by Amplify |
| Documentation-only commit | Yes | No functional change unless build configuration changes |

So the mental model is:

```text
GitHub push -> Amplify notices commit -> Amplify builds site/
```

This is separate from:

```text
zip lambda/ -> aws lambda update-function-code -> Lambda backend changes
```

### Frontend: Amplify Deployment

Amplify is configured by `amplify.yml`:

```yaml
artifacts:
  baseDirectory: site
  files:
    - '**/*'
```

Every push to the connected branch redeploys the static frontend from `site/`.

Amplify also injects the API Gateway URL and public Turnstile sitekey into `site/config.js` during build:

```yaml
- "echo \"window.CONFIG = { apiUrl: '${API_GATEWAY_URL}', turnstileSiteKey: '${TURNSTILE_SITE_KEY}' };\" > site/config.js"
```

Required Amplify environment variables:

```text
API_GATEWAY_URL=https://your-api-id.execute-api.ap-northeast-1.amazonaws.com
TURNSTILE_SITE_KEY=your-public-turnstile-sitekey
```

### Documentation-Only Commits

Documentation-only commits currently still trigger an Amplify build and deployment for this connected branch. For example, a commit ending in `[skip cd]` on May 27, 2026 still ran successful `BUILD`, `DEPLOY`, and `VERIFY` steps.

Do not rely on `[skip cd]` to avoid Amplify builds in this project. Lambda deployment remains separate either way: a GitHub push does not upload backend code to Lambda.

### Backend: Lambda Deployment

Deploy Lambda manually after changing files in `lambda/`:

```bash
cd lambda
npm install
zip -r ../lambda.zip .
aws lambda update-function-code \
  --function-name invite-generate \
  --region ap-northeast-1 \
  --zip-file fileb://../lambda.zip
aws lambda wait function-updated \
  --function-name invite-generate \
  --region ap-northeast-1
```

The wait command matters because AWS may accept the upload before the function is fully ready for new invocations.

### When Lambda Needs A Code Upload

Lambda configuration changes and Lambda code deployments are separate operations. Updating an API key or environment variable changes the configuration used by the already deployed code; it does not require uploading a new `.zip` file. Code or dependency changes do require a new upload.

| Change | Lambda code upload required? |
|---|---:|
| Change an API key or an existing environment variable value | No |
| Add an environment variable already consumed by deployed code | No |
| Edit `generate.js` | Yes |
| Add npm dependencies, such as the DynamoDB SDK | Yes |
| Change runtime, permissions, memory, timeout, or environment configuration | No code upload; configuration update required |

The DynamoDB invite-store release needs both kinds of update: the table permission and `INVITE_TABLE_NAME` configuration, plus a code upload containing the new DynamoDB behavior and SDK packages.

## Lambda Environment Variables

Set these on the `invite-generate` Lambda function:

```text
OPENAI_API_KEY=...
AWS_BEARER_TOKEN_BEDROCK=...
BEDROCK_REGION=ap-northeast-1
BEDROCK_CLAUDE_MODEL_ID=global.anthropic.claude-haiku-4-5-20251001-v1:0
SES_FROM_EMAIL=invites@jaycloud.net
SES_REGION=ap-northeast-1
SES_CALENDAR_TIMEZONE=Europe/London
INVITE_TABLE_NAME=invite-records
ACCEPTANCE_LOCK_SECONDS=60
ANONYMOUS_INVITE_DAILY_LIMIT=3
ANONYMOUS_RATE_LIMIT_SALT=generate-a-long-random-secret
TURNSTILE_SECRET_KEY=your-private-turnstile-secret-key
TURNSTILE_EXPECTED_HOSTNAMES=main.d23hnd7ddlxmg8.amplifyapp.com
```

`AWS_BEARER_TOKEN_BEDROCK` is the Amazon Bedrock API key used for this exercise. For a longer-lived workload, prefer granting the Lambda execution role Bedrock invocation permissions instead of storing a long-term API key. `BEDROCK_CLAUDE_MODEL_ID` is optional and defaults to the global Claude Haiku 4.5 inference profile. `SES_CALENDAR_TIMEZONE` is optional. The frontend also passes the sender's browser timezone when generating an invite.

`ANONYMOUS_INVITE_DAILY_LIMIT` defaults to `3`. Before performing AI generation, Lambda atomically reserves invitation allowances in DynamoDB for both the API Gateway source IP and the notification email address for the current UTC date. This intentionally charges failed generation attempts too, so repeatedly triggering model failures cannot bypass the cost guardrail. `ANONYMOUS_RATE_LIMIT_SALT` makes the stored source-IP and email fingerprints non-reversible without the secret; configure it to a long random value.

This preserves public use, but an IP address or submitted email is not a verified user identity: people on one shared network share an allowance, and an attacker can consume a target email address's allowance for the day. Configure API Gateway throttling and operational alerts as additional protections. A stronger public product would add CAPTCHA or account/email verification.

## Cloudflare Turnstile Bot Protection

Turnstile protects invitation generation before Lambda reserves rate-limit capacity or invokes any AI models. The browser sends a short-lived token with the generation request, and Lambda validates it using Cloudflare's Siteverify API. Tokens are single-use and expire after five minutes.

### Configure Turnstile

1. In the Cloudflare dashboard, go to **Turnstile** and select **Add widget**.
2. Choose **Managed** widget mode.
3. Add the production hostname:

   ```text
   main.d23hnd7ddlxmg8.amplifyapp.com
   ```

4. Copy the widget **sitekey** and **secret key**.
5. In Amplify Hosting, add the public sitekey environment variable:

   ```text
   TURNSTILE_SITE_KEY=<sitekey>
   ```

6. In Lambda, add the private secret and expected production hostname:

   ```text
   TURNSTILE_SECRET_KEY=<secret-key>
   TURNSTILE_EXPECTED_HOSTNAMES=main.d23hnd7ddlxmg8.amplifyapp.com
   ```

Do not put `TURNSTILE_SECRET_KEY` in Amplify or `site/config.js`; it must remain server-side in Lambda. If a custom domain is added later, add it to the Turnstile widget and to the comma-separated `TURNSTILE_EXPECTED_HOSTNAMES` value.

Deploy in this order to avoid a temporary broken generator:

1. Create the Turnstile widget and set `TURNSTILE_SITE_KEY` in Amplify.
2. Deploy the updated frontend so generation requests include Turnstile tokens.
3. Set `TURNSTILE_SECRET_KEY` and `TURNSTILE_EXPECTED_HOSTNAMES` in Lambda.
4. Deploy the updated Lambda code that enforces verification.

### Local Turnstile Testing

Cloudflare provides dummy credentials for local testing. Configure `site/config.js` with the always-pass public test sitekey:

```js
window.CONFIG = {
  apiUrl: 'https://your-api-id.execute-api.ap-northeast-1.amazonaws.com',
  turnstileSiteKey: '1x00000000000000000000AA',
};
```

Configure Lambda with the matching always-pass test secret only in a non-production/test environment:

```text
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

Production Turnstile secret keys reject dummy tokens, so do not mix test browser configuration with the production Lambda.

## DynamoDB Invite Store

### Why This Table Exists

DynamoDB makes each invitation a server-owned record instead of relying on invitation details sent through a public URL and posted back by the browser. Before this change, the shared URL could contain sender email, message, activity, and date values, and duplicate-email prevention depended on browser `sessionStorage`.

| Problem | Without DynamoDB | With DynamoDB |
|---|---|---|
| Duplicate calendar emails | A second browser or cleared session could send again | Lambda records `SENT` and does not send again |
| Personal data in shared URLs | Invitation and sender data can appear in query parameters | The link contains only `inviteId` |
| Forged acceptance requests | A caller can submit a different email destination | Lambda sends only from a stored invitation record |

When an invitation is generated, Lambda stores the private details and returns an ID used in the shareable link:

```text
/invite.html?id=<inviteId>
```

When the recipient opens that link, Lambda returns only recipient-visible fields. When the recipient clicks **Yes!**, the browser submits only `inviteId`, and Lambda performs the acceptance transition:

```text
CREATED -> SENDING -> SENT
```

Only the request that successfully reserves `SENDING` sends the SES calendar email. Later acceptances return that the calendar invite was already sent. DynamoDB is therefore both the invitation store and the server-side duplicate-send guard.

Before AI generation or invite creation, Lambda also stores daily usage counters under anonymized source-IP and notification-email fingerprints. Once either fingerprint has generated three invitations in one UTC day, further generation requests receive HTTP `429` until the next UTC day. Since each stored invitation can send at most one email, a mailbox cannot be targeted through this endpoint more than three times per UTC day without changing the destination address.

Create a DynamoDB table in the Lambda region with `inviteId` as its partition key:

```bash
aws dynamodb create-table \
  --table-name invite-records \
  --attribute-definitions AttributeName=inviteId,AttributeType=S \
  --key-schema AttributeName=inviteId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region ap-northeast-1

aws dynamodb wait table-exists \
  --table-name invite-records \
  --region ap-northeast-1
```

Add these Lambda environment variables:

```text
INVITE_TABLE_NAME=invite-records
ACCEPTANCE_LOCK_SECONDS=60
ANONYMOUS_INVITE_DAILY_LIMIT=3
ANONYMOUS_RATE_LIMIT_SALT=generate-a-long-random-secret
TURNSTILE_SECRET_KEY=your-private-turnstile-secret-key
TURNSTILE_EXPECTED_HOSTNAMES=main.d23hnd7ddlxmg8.amplifyapp.com
```

`ACCEPTANCE_LOCK_SECONDS` is optional. It allows a later request to retry an invite left in `SENDING` if an invocation stops before finishing.
`ANONYMOUS_RATE_LIMIT_SALT` should be set once and retained; rotating it resets the effective counters because it changes source-IP fingerprints.

Optionally enable DynamoDB TTL on the `expiresAt` attribute. Usage-counter records are written with expiry timestamps; TTL keeps old counter records from accumulating after their windows have passed:

```bash
aws dynamodb update-time-to-live \
  --table-name invite-records \
  --time-to-live-specification "Enabled=true, AttributeName=expiresAt" \
  --region ap-northeast-1
```

Grant the Lambda execution role access to the invite table, substituting your AWS account ID:

```json
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem"
  ],
  "Resource": "arn:aws:dynamodb:ap-northeast-1:YOUR_ACCOUNT_ID:table/invite-records"
}
```

An invite begins as `CREATED`. The first acceptance conditionally changes it to `SENDING`, sends SES email, and changes it to `SENT`; duplicate acceptances do not send again. A clear SES send failure changes it to `FAILED` so it can be retried. The calendar event UID is derived from `inviteId`, limiting duplicate calendar events if an SES success occurs before Lambda can persist `SENT`.

## SES Calendar Invite Procedure

1. Open Amazon SES in `ap-northeast-1`.
2. Verify the domain `jaycloud.net`.
3. Confirm DKIM is successful for the domain.
4. Use a sender address under that verified domain, for example:

   ```text
   invites@jaycloud.net
   ```

5. Request SES production access in `ap-northeast-1`.
6. Confirm production access:

   ```bash
   aws sesv2 get-account --region ap-northeast-1
   ```

   Expected:

   ```json
   "ProductionAccessEnabled": true
   ```

7. Add SES permission to the Lambda execution role:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "ses:SendRawEmail",
         "Resource": "*"
       }
     ]
   }
   ```

8. Set Lambda environment variables:

   ```text
   SES_FROM_EMAIL=invites@jaycloud.net
   SES_REGION=ap-northeast-1
   ```

When the recipient clicks **Yes!**, Lambda sends a raw MIME email with a `text/calendar` `.ics` attachment. Calendar apps such as Google Calendar and Outlook can recognize the attachment as an event invite.

## API Gateway Setup

1. Create an HTTP API in API Gateway.
2. Add Lambda integration for `invite-generate`.
3. Add route:

   ```text
   POST /generate
   ```

4. Deploy the API.
5. Copy the invoke URL.
6. Add it to Amplify as `API_GATEWAY_URL`.

Because this route is public, set API Gateway throttling for `POST /generate` and alert on unexpected Lambda, Bedrock, OpenAI, and SES usage. Turnstile rejects ordinary automated generation attempts before model spend. The application-level daily limit controls repeated invite generation from one source IP and repeated notifications to one email address; API throttling helps with bursts, reaction requests, and distributed attempts.

The frontend calls:

```js
fetch(`${API_URL}/generate`, ...)
```

## Local Development

Set `apiUrl` and a Turnstile testing sitekey in `site/config.js` as documented above, then serve the static site:

```bash
npx serve site
```

Or use Python:

```bash
cd site
python3 -m http.server 4173
```

Open:

```text
http://127.0.0.1:4173
```

## Troubleshooting

### Yes Page Says Calendar Invite Is Unavailable In Local Preview

`yes.html` could not find `window.CONFIG.apiUrl`. Confirm `site/config.js` exists and is loaded before `app.js`.

### Yes Page Says Could Not Send Calendar Invite

Check Lambda logs:

```bash
aws logs tail /aws/lambda/invite-generate \
  --region ap-northeast-1 \
  --since 10m \
  --format short
```

### Frontend Changed But Lambda Behavior Did Not

Amplify only deploys `site/`. Redeploy Lambda manually with `update-function-code`.

### Lambda Changed But Frontend Behavior Did Not

Confirm Amplify finished deploying the latest Git commit, then hard-refresh the browser or use a newly generated invite link.
