# ✅ GitHub Secrets Setup Checklist

## 🎯 Quick Setup Guide

### Step 1: Go to GitHub Repository Settings
1. Navigate to your repository: `https://github.com/NR-ESEFW/e2e-test-report`
2. Click **Settings** tab
3. Go to **Secrets and variables** → **Actions**

### Step 2: Add Repository Secrets
Click **"New repository secret"** and add each of these:

#### 📊 Google Sheets Secrets
```
Name: GOOGLE_SHEETS_SPREADSHEET_ID
Value: 1QBE6tv-Z3OMv9mZgNG3Qs2EV2K9kaz-rPgzwADLIhs8
```

```
Name: GOOGLE_SHEETS_GID  
Value: 164737210
```

```
Name: GOOGLE_CLIENT_ID
Value: 850380285134-e9vl4i2g7k8qkvs2409gu4rokqkksrfo.apps.googleusercontent.com
```

```
Name: GOOGLE_CLIENT_SECRET
Value: [Your Google Client Secret]
```

```
Name: GOOGLE_OAUTH_CREDENTIALS
Value: [Content of your oauth-credentials.json file]
```

#### 🐛 JIRA Integration Secrets
```
Name: JIRA_BASE_URL
Value: https://new-relic.atlassian.net
```

```
Name: JIRA_EMAIL
Value: svc-xray@newrelic.com  
```

```
Name: JIRA_API_TOKEN
Value: [Your JIRA API Token]
```

```
Name: JIRA_CLIENT_SECRET
Value: [Your JIRA Client Secret]
```

#### 🧪 X-Ray Secrets
```
Name: XRAY_CLIENT_ID
Value: [Your X-Ray Client ID]
```

```
Name: XRAY_CLIENT_SECRET
Value: [Your X-Ray Client Secret]
```

### Step 3: Test the Workflow
1. Go to **Actions** tab in your repository
2. Click **"Generate E2E Test & Bug Reports"**
3. Click **"Run workflow"** → **"Run workflow"**

## 🚀 What Happens After Setup

### ✅ Automated Daily Reports
- Runs every day at 9 AM UTC
- Generates fresh test results and bug data
- Stores report as downloadable artifact

### 📊 Manual Execution
- Trigger anytime via GitHub Actions UI
- Choose environment (production/staging/development)
- Download generated reports immediately

### 🔔 Benefits
- **🔒 Secure**: Secrets never exposed in code
- **🤖 Automated**: No manual intervention needed
- **📈 Consistent**: Same process every time
- **📱 Accessible**: Team can download reports anytime

## 🛠️ Troubleshooting

### Common Issues:
1. **"Secret not found"** → Check secret name spelling
2. **"Authentication failed"** → Verify token validity
3. **"Permission denied"** → Check service account permissions

### Debug Mode:
Add this to workflow for debugging:
```yaml
- name: 🔍 Debug Environment  
  run: |
    echo "Checking environment variables..."
    echo "JIRA_BASE_URL is set: ${{ secrets.JIRA_BASE_URL != '' }}"
    echo "Google Sheets ID is set: ${{ secrets.GOOGLE_SHEETS_SPREADSHEET_ID != '' }}"
```