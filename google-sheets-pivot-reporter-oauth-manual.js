#!/usr/bin/env node

/**
 * ORIGINAL FILE WITH UI-ONLY ENHANCEMENTS
 * ✅ Test Results: 100% UNCHANGED
 * ✅ JIRA Fetching: 100% UNCHANGED  
 * ✅ All Logic: 100% UNCHANGED
 * 🎨 Bug Reports HTML: Modern UI only
 * 🎨 Regression HTML: Modern UI only
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

class GoogleSheetsPivotReporterOAuth {
  constructor(spreadsheetId) {
    this.spreadsheetId = spreadsheetId;
    this.sheets = null;
    this.oauth2Client = null;
    this.allData = [];
    this.tokenPath = path.join(process.cwd(), 'google-token.json');
    this.sheetSummaries = [];
    this.indexSheetRows = null;
    this.jiraBugs = [];
    this.bugMetrics = { priorities: {}, statuses: {} };
    this.enhancedAssigneeStats = {};
    this.enhancedReporterStats = {};
    this.regressionAssignedStats = {};
    this.regressionReportedStats = {};
  }

  async authenticate(authCode) {
    console.log('🔐 Authenticating...');
    
    const credentialsPath = path.join(process.cwd(), 'oauth-credentials.json');
    if (!fs.existsSync(credentialsPath)) {
      throw new Error('❌ oauth-credentials.json not found');
    }

    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;

    this.oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0] || 'http://localhost');

    if (fs.existsSync(this.tokenPath)) {
      const token = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
      this.oauth2Client.setCredentials(token);
      
      this.oauth2Client.on('tokens', (newTokens) => {
        const updatedTokens = { ...token, ...newTokens };
        fs.writeFileSync(this.tokenPath, JSON.stringify(updatedTokens));
      });
      
      const expiryDate = token.expiry_date || 0;
      if (expiryDate && expiryDate < Date.now() + 60000) {
        try {
          const { credentials: newCreds } = await this.oauth2Client.refreshAccessToken();
          fs.writeFileSync(this.tokenPath, JSON.stringify({ ...token, ...newCreds }));
        } catch (e) {
          console.warn('⚠️ Token refresh failed, continuing with existing token');
        }
      }
    } else if (authCode) {
      const { tokens } = await this.oauth2Client.getToken(authCode);
      this.oauth2Client.setCredentials(tokens);
      fs.writeFileSync(this.tokenPath, JSON.stringify(tokens));
    } else {
      const authUrl = this.oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
      throw new Error(`❌ No token. Visit: ${authUrl}\nThen run: node script.js <code>`);
    }

    this.sheets = google.sheets({ version: 'v4', auth: this.oauth2Client });
    console.log('✅ Authenticated\n');
  }

  async fetchAllSheetsData() {
    console.log('📊 Fetching spreadsheet metadata...');
    
    const metadata = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
    });
    
    const allSheetTitles = metadata.data.sheets.map(s => s.properties.title);
    const sheetNames = allSheetTitles.filter(name => name.toLowerCase() !== 'index');
    
    console.log(`   Found ${sheetNames.length} sheets`);

    const cellRefPattern = /^[A-Za-z]{1,3}[-]?\d+$/;
    const safeSheets = [];
    const problematicSheets = [];
    for (const name of allSheetTitles) {
      if (cellRefPattern.test(name.replace(/[' ]/g, ''))) {
        problematicSheets.push(name);
      } else {
        safeSheets.push(name);
      }
    }

    const ranges = safeSheets.map(name => `'${name.trim()}'`);

    console.log('📥 Fetching all sheet data in batch...');
    if (problematicSheets.length > 0) {
      console.log(`   ⚠️  ${problematicSheets.length} sheet(s) with ambiguous names will be fetched individually`);
    }

    let valueRangesMap = new Map();
    if (ranges.length > 0) {
      const batchResponse = await this.sheets.spreadsheets.values.batchGet({
        spreadsheetId: this.spreadsheetId,
        ranges: ranges,
      });
      batchResponse.data.valueRanges.forEach((valueRange, idx) => {
        valueRangesMap.set(safeSheets[idx], valueRange.values || []);
      });
    }

    for (const name of problematicSheets) {
      try {
        console.log(`   📄 Fetching sheet "${name}"...`);
        const resp = await this.sheets.spreadsheets.values.get({
          spreadsheetId: this.spreadsheetId,
          range: `'${name}'!A1:ZZ`,
        });
        valueRangesMap.set(name, resp.data.values || []);
      } catch (err) {
        console.warn(`   ⚠️  Skipping sheet "${name}": ${err.message}`);
        valueRangesMap.set(name, []);
      }
    }

    const allData = [];
    this.sheetSummaries = [];
    this.indexSheetRows = null;

    allSheetTitles.forEach((sheetName) => {
      const rows = valueRangesMap.get(sheetName);

      if (sheetName.toLowerCase() === 'index') {
        if (rows && rows.length > 1) {
          this.indexSheetRows = rows;
        }
        return;
      }

      if (!rows || rows.length === 0) {
        this.sheetSummaries.push({ name: sheetName, rowCount: 0, headerFound: false });
        return;
      }

      const headerRowIdx = rows.findIndex(row => 
        row.some(cell => cell && cell.toLowerCase().includes('tester'))
      );
      
      if (headerRowIdx === -1) {
        this.sheetSummaries.push({ name: sheetName, rowCount: 0, headerFound: false });
        return;
      }

      const header = rows[headerRowIdx];
      const testerIdx = header.findIndex(cell => cell && cell.toLowerCase().includes('tester'));
      const statusIdx = header.findIndex(cell => cell && cell.toLowerCase().includes('overall status'));
      const defectIdx = header.findIndex(cell => cell && cell.toLowerCase().includes('defect'));
      const commentsIdx = header.findIndex(cell => cell && cell.toLowerCase().includes('comment'));
      const iterationIdx = header.findIndex(cell => cell && cell.toLowerCase().includes('iteration'));

      const rowCount = rows.length - headerRowIdx - 1;
      this.sheetSummaries.push({ name: sheetName, rowCount, headerFound: true });

      for (let i = headerRowIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const tester = row[testerIdx] || '';
        const rawStatus = row[statusIdx] || '';
        const status = rawStatus.trim() ? rawStatus.trim() : 'Not Started';
        
        if (!tester.trim()) continue;
        
        const defect = defectIdx !== -1 ? row[defectIdx] || '' : '';
        const comments = commentsIdx !== -1 ? row[commentsIdx] || '' : '';
        
        let iteration = '';
        if (iterationIdx !== -1) {
          iteration = row[iterationIdx] || '';
        } else {
          const match = sheetName.match(/(itr[- ]?\d+)/i);
          iteration = match ? match[1] : '';
        }
        iteration = iteration.replace(/itr[- ]?/i, '').trim();

        allData.push({ tester, jiraTicket: sheetName, iteration, overallStatus: status, defect, comments });
      }
    });

    this.allData = allData;
    console.log(`✅ Processed ${sheetNames.length} sheets, ${allData.length} rows\n`);
    return allData;
  }

  generateHTMLReport() {
    const statusColors = {
      'Passed': '#4CAF50',
      'PASSED': '#4CAF50',
      'Failed': '#F44336',
      'FAILED': '#F44336',
      'Blocked': '#E91E63',
      'BLOCKED': '#E91E63',
      'Not Started': '#9E9E9E',
      'NOT STARTED': '#9E9E9E',
      'NOT_STARTED': '#9E9E9E',
      'In Progress': '#FF9800',
      'IN PROGRESS': '#FF9800',
      'IN_PROGRESS': '#FF9800',
      'In-Valid': '#B0BEC5',
      'IN-VALID': '#B0BEC5',
      'IN_VALID': '#B0BEC5',
    };
    const statusOrder = ['Passed', 'Failed', 'Blocked', 'In Progress', 'Not Started', 'In-Valid'];

    const statusSet = new Set(this.allData.map(row => row.overallStatus).filter(s => s));
    const statusList = statusOrder.filter(s => statusSet.has(s));
    statusSet.forEach(s => { if (!statusList.includes(s)) statusList.push(s); });

    const grouped = {};
    this.allData.forEach(row => {
      const key = row.tester?.trim();
      if (!key) return;
      if (!grouped[key]) grouped[key] = { 
        tester: key, 
        rows: [], 
        statusCounts: {}, 
        ticketIterations: new Map()
      };
      grouped[key].rows.push(row);
      grouped[key].statusCounts[row.overallStatus] = (grouped[key].statusCounts[row.overallStatus] || 0) + 1;
      
      const ticket = row.jiraTicket;
      if (!grouped[key].ticketIterations.has(ticket)) {
        grouped[key].ticketIterations.set(ticket, new Set());
      }
      grouped[key].ticketIterations.get(ticket).add(row.iteration || '1');
    });

    const sortedTesters = Object.keys(grouped).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    
    const data = sortedTesters.map(testerName => {
      const group = grouped[testerName];
      const uniqueTicketCount = group.ticketIterations.size;
      
      const ticketDetails = [];
      for (const [ticket, iterations] of group.ticketIterations) {
        const count = iterations.size;
        ticketDetails.push({ ticket, count });
      }
      
      return {
        testerName,
        statusCounts: statusList.map(status => group.statusCounts[status] || 0),
        total: group.rows.length,
        uniqueTicketCount: uniqueTicketCount,
        ticketDetails: ticketDetails
      };
    });

    let indexStoriesTable = '';
    if (this.indexSheetRows?.length > 1) {
      const header = this.indexSheetRows[0];
      const bodyRows = this.indexSheetRows.slice(1).filter(row => row.some(cell => cell));
      
      let testScenarioIdx = 0, testExecutionIdx = 1, testStoryIdx = 3, descIdx = 2, statusIdx = 4;
      header.forEach((cell, i) => {
        const lc = cell?.toLowerCase() || '';
        if (lc.includes('test scenario')) testScenarioIdx = i;
        if (lc.includes('test execution')) testExecutionIdx = i;
        if (lc.includes('test story')) testStoryIdx = i;
        if (lc.includes('description')) descIdx = i;
        if (lc.includes('status')) statusIdx = i;
      });

      const statusCountsMap = {};
      bodyRows.forEach(row => {
        const status = row[statusIdx] || '';
        if (status.trim()) {
          statusCountsMap[status] = (statusCountsMap[status] || 0) + 1;
        }
      });

      const filteredLabels = Object.keys(statusCountsMap).filter(s => statusCountsMap[s] > 0);
      const filteredCounts = filteredLabels.map(s => statusCountsMap[s]);
      const filteredColors = filteredLabels.map(s => statusColors[s] || '#ffe082');

      const jiraBaseUrl = 'https://new-relic.atlassian.net/projects/NR?selectedItem=com.atlassian.plugins.atlassian-connect-plugin:com.xpandit.plugins.xray__testing-board#!page=test-run&testExecutionKey=NR-488556&testPlanId=725086&testKey=';

      indexStoriesTable = `
        <h2>Index of Stories</h2>
        <table>
          <thead><tr><th>Test Scenario</th><th>Test Execution</th><th>Test Story</th><th>Description</th><th>Status</th></tr></thead>
          <tbody>
            ${bodyRows.map(row => {
              const testScenario = row[testScenarioIdx] || '';
              const testExecution = row[testExecutionIdx] || '';
              const testStory = row[testStoryIdx] || '';
              const description = row[descIdx] || '';
              const status = row[statusIdx] || '';
              const color = statusColors[status] || '#e0e0e0';
              
              let testScenarioCell = testScenario;
              if (testScenario && testScenario.includes('http')) {
                const urlMatch = testScenario.match(/https?:\/\/[^\s)]+/);
                const linkText = testScenario.replace(/https?:\/\/[^\s)]+/, '').trim().replace(/[()]/g, '') || 'Link';
                if (urlMatch) {
                  testScenarioCell = `<a href="${urlMatch[0]}" target="_blank" style="color:#1a73e8;text-decoration:none;font-weight:bold;">${linkText}</a>`;
                }
              } else if (testScenario && testScenario.startsWith('NR-')) {
                testScenarioCell = `<a href="${jiraBaseUrl}${testScenario}" target="_blank" style="color:#1a73e8;text-decoration:none;font-weight:bold;">${testScenario}</a>`;
              }
              
              const jiraLink = testStory ? `<a href="${jiraBaseUrl}${testStory}" target="_blank" style="color:#1a73e8;text-decoration:none;font-weight:bold;">${testStory}</a>` : '';
              return `<tr><td>${testScenarioCell}</td><td>${testExecution}</td><td>${jiraLink}</td><td>${description}</td><td style="background:${color};font-weight:bold;padding:6px;border-radius:4px;color:white;text-align:center;">${status}</td></tr>`;
            }).join('')}
          </tbody>
        </table>
        <h3>Stories by Status</h3>
        <canvas id="indexStoriesBarChart" width="600" height="250"></canvas>
        <script>
          window.addEventListener('DOMContentLoaded', function() {
            new Chart(document.getElementById('indexStoriesBarChart').getContext('2d'), {
              type: 'bar',
              data: { labels: ${JSON.stringify(filteredLabels)}, datasets: [{ label: 'Count', data: ${JSON.stringify(filteredCounts)}, backgroundColor: ${JSON.stringify(filteredColors)} }] },
              options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
            });
          });
        </script>`;
    }

    const statusCounts = statusList.map(status => this.allData.filter(row => row.overallStatus === status).length);
    const barLabels = data.map(row => row.testerName);
    const barDataSets = statusList.map((status, idx) => ({
      label: status,
      data: data.map(row => row.statusCounts[idx]),
      backgroundColor: statusColors[status] || '#e0e0e0',
    }));

    const testerOptions = sortedTesters.map(t => `<option value="${t}">${t}</option>`).join('');
    const statusOptions = statusList.map(s => `<option value="${s}">${s}</option>`).join('');

    const aggregateBlocks = data.map(row => {
      const group = grouped[row.testerName];
      const statusSummary = statusOrder.filter(s => group.statusCounts[s]).map(s => 
        `<span style="background:${statusColors[s]};padding:2px 8px;border-radius:6px;margin-right:6px;">${s}: <b>${group.statusCounts[s]}</b></span>`
      ).join(' ');
      
      const allStatuses = Object.keys(group.statusCounts).filter(s => group.statusCounts[s] > 0);
      const sortedRows = statusOrder.flatMap(status => group.rows.filter(r => r.overallStatus === status));
      
      const ticketDetailsHTML = [];
      let index = 0;
      
      group.rows.forEach(row => {
        const bgColor = index % 2 === 0 ? '#f8fafc' : '#ffffff';
        const borderColor = statusColors[row.overallStatus] || '#e0e0e0';
        
        ticketDetailsHTML.push(`
          <div data-status="${row.overallStatus}" style="
            background: ${bgColor};
            border-left: 4px solid ${borderColor};
            margin: 4px 0;
            padding: 8px 12px;
            border-radius: 6px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            transition: all 0.2s ease;
          " onmouseover="this.style.boxShadow='0 4px 8px rgba(0,0,0,0.15)'" onmouseout="this.style.boxShadow='0 1px 3px rgba(0,0,0,0.1)'">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <div>
                <span style="font-weight: 600; color: #374151; font-size: 0.9em;">${row.jiraTicket}</span>
                <span style="
                  background: rgba(107, 114, 128, 0.1);
                  color: #6b7280;
                  padding: 2px 8px;
                  border-radius: 12px;
                  font-size: 0.75em;
                  font-weight: 600;
                  margin-left: 8px;
                ">${row.iteration}</span>
              </div>
              <span style="
                background: ${statusColors[row.overallStatus] || '#e0e0e0'};
                color: ${row.overallStatus === 'Passed' ? '#065f46' : row.overallStatus === 'Failed' ? '#92400e' : row.overallStatus === 'Blocked' ? '#7f1d1d' : '#374151'};
                padding: 2px 8px;
                border-radius: 8px;
                font-size: 0.75em;
                font-weight: 700;
                text-transform: uppercase;
              ">${row.overallStatus}</span>
            </div>
          </div>`);
        index++;
      });
      
      const ticketDetailsHTMLString = ticketDetailsHTML.join('');
      
      return `
        <div class="aggregate-block" data-tester="${row.testerName}" data-statuses="${allStatuses.join(',')}">
          <div style="
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 12px;
            margin: 20px 0;
            box-shadow: 0 8px 32px rgba(102, 126, 234, 0.2);
            overflow: hidden;
          ">
            <div style="
              background: rgba(255, 255, 255, 0.95);
              padding: 20px;
              border-bottom: 1px solid rgba(102, 126, 234, 0.1);
            ">
              <h3 style="
                margin: 0 0 12px 0;
                color: #1f2937;
                font-size: 1.4em;
                font-weight: 700;
                display: flex;
                align-items: center;
              ">
                <span style="
                  background: linear-gradient(135deg, #667eea, #764ba2);
                  -webkit-background-clip: text;
                  -webkit-text-fill-color: transparent;
                  background-clip: text;
                ">${row.testerName}</span>
                <span style="
                  background: #374151;
                  color: white;
                  padding: 4px 10px;
                  border-radius: 20px;
                  font-size: 0.7em;
                  margin-left: 12px;
                  font-weight: 600;
                ">TESTER</span>
              </h3>

              <div style="
                background: linear-gradient(135deg, #3b82f6, #1d4ed8);
                color: white;
                padding: 12px 16px;
                border-radius: 8px;
                margin-bottom: 12px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
                cursor: pointer;
                transition: all 0.2s ease;
              " onclick="toggleTesterDetails('${row.testerName.replace(/\s+/g, '')}'); this.style.transform = this.style.transform === 'scale(0.98)' ? 'scale(1)' : 'scale(0.98)'; setTimeout(() => this.style.transform = 'scale(1)', 100);">
                <span style="font-weight: 600; font-size: 1.05em;">📋 Total Tickets under ${row.testerName}</span>
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="
                    background: rgba(255, 255, 255, 0.2);
                    padding: 4px 12px;
                    border-radius: 20px;
                    font-weight: 700;
                    font-size: 1.1em;
                  ">${row.uniqueTicketCount}</span>
                  <span id="toggle-icon-${row.testerName.replace(/\s+/g, '')}" style="
                    font-size: 1.2em;
                    transition: transform 0.3s ease;
                  ">▼</span>
                </div>
              </div>
              
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px;">
                
                <div data-section="ticket-details" style="
                  background: #f9fafb;
                  border-radius: 8px;
                  padding: 12px;
                  border: 1px solid #e5e7eb;
                ">
                  <h4 style="margin: 0 0 10px 0; color: #374151; font-size: 1em;">🎫 Ticket Details</h4>
                  ${ticketDetailsHTMLString}
                </div>
                
                <div style="
                  background: #ffffff;
                  border-radius: 8px;
                  padding: 12px;
                  border: 1px solid #e5e7eb;
                  text-align: center;
                ">
                  <h4 style="margin: 0 0 15px 0; color: #374151; font-size: 1em;">📊 Performance Metrics</h4>
                  
                  <div style="margin-bottom: 20px;">
                    <canvas id="pieChart-${row.testerName.replace(/\s+/g, '')}" width="200" height="200"></canvas>
                  </div>
                  
                  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; text-align: center;">
                    <div style="background: #10b981; color: white; padding: 8px; border-radius: 6px; font-size: 0.9em;">
                      <div style="font-weight: 600;">✅ Passed</div>
                      <div style="font-size: 1.2em;">${group.statusCounts.Passed || 0}</div>
                    </div>
                    <div style="background: #f59e0b; color: white; padding: 8px; border-radius: 6px; font-size: 0.9em;">
                      <div style="font-weight: 600;">⚡ Progress</div>
                      <div style="font-size: 1.2em;">${group.statusCounts['In Progress'] || 0}</div>
                    </div>
                    <div style="background: #ef4444; color: white; padding: 8px; border-radius: 6px; font-size: 0.9em;">
                      <div style="font-weight: 600;">❌ Failed</div>
                      <div style="font-size: 1.2em;">${group.statusCounts.Failed || 0}</div>
                    </div>
                    <div style="background: #8b5cf6; color: white; padding: 8px; border-radius: 6px; font-size: 0.9em;">
                      <div style="font-weight: 600;">🚫 Blocked</div>
                      <div style="font-size: 1.2em;">${group.statusCounts.Blocked || 0}</div>
                    </div>
                  </div>
                  
                  <div style="margin-top: 15px; padding: 10px; background: linear-gradient(45deg, #10b981, #059669); color: white; border-radius: 8px;">
                    <div style="font-weight: 600; font-size: 0.9em;">📊 Pass Rate</div>
                    <div style="font-size: 1.4em; font-weight: 700;">${(() => {
                      const totalCases = Object.values(group.statusCounts).reduce((sum, count) => sum + count, 0);
                      const passedCases = group.statusCounts.Passed || 0;
                      return totalCases > 0 ? Math.round((passedCases / totalCases) * 100) : 0;
                    })()}%</div>
                  </div>
                </div>
              </div>
              
              <div id="details-${row.testerName.replace(/\s+/g, '')}" style="
                max-height: 0;
                overflow: hidden;
                transition: max-height 0.4s ease-in-out, padding 0.3s ease;
                background: #ffffff;
                border-radius: 8px;
                margin-top: 12px;
              ">
                <div style="padding: 16px;">
                  <h4 style="margin: 0 0 12px 0; color: #374151; font-size: 1.1em; font-weight: 600;">📊 Detailed Test Execution Results</h4>
                  
                  <table style="width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                    <thead>
                      <tr style="background: linear-gradient(135deg, #667eea, #764ba2); color: white;">
                        <th style="padding: 12px; text-align: left; font-weight: 600; font-size: 0.9em;">🎫 Jira Ticket</th>
                        <th style="padding: 12px; text-align: left; font-weight: 600; font-size: 0.9em;">🔄 Iteration</th>
                        <th style="padding: 12px; text-align: left; font-weight: 600; font-size: 0.9em;">📊 Status</th>
                        <th style="padding: 12px; text-align: left; font-weight: 600; font-size: 0.9em;">🐛 Defects</th>
                        <th style="padding: 12px; text-align: left; font-weight: 600; font-size: 0.9em;">💬 Comments</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${sortedRows.map((r, index) => {
                        const rowBg = index % 2 === 0 ? '#ffffff' : '#f8fafc';
                        return `
                        <tr style="
                          background: ${rowBg};
                          transition: all 0.2s ease;
                        " onmouseover="this.style.background='#e0e7ff'" onmouseout="this.style.background='${rowBg}'">
                          <td style="padding: 12px; color: #1f2937; font-weight: 600; font-size: 0.9em;">${r.jiraTicket}</td>
                          <td style="padding: 12px; color: #6b7280; font-size: 0.9em;">${r.iteration}</td>
                          <td style="padding: 8px;">
                            <span style="
                              background: ${statusColors[r.overallStatus] || '#e0e0e0'};
                              color: ${r.overallStatus === 'Passed' ? '#065f46' : r.overallStatus === 'Failed' ? '#92400e' : r.overallStatus === 'Blocked' ? '#7f1d1d' : '#374151'};
                              font-weight: 700;
                              border-radius: 6px;
                              text-align: center;
                              text-transform: uppercase;
                              font-size: 0.8em;
                              padding: 6px 12px;
                              display: inline-block;
                              min-width: 80px;
                            ">${r.overallStatus}</span>
                          </td>
                          <td style="padding: 12px; color: #6b7280; font-size: 0.9em;">${r.defects || '-'}</td>
                          <td style="padding: 12px; color: #6b7280; font-size: 0.85em; max-width: 200px; word-wrap: break-word;">${r.comments || '-'}</td>
                        </tr>`;
                      }).join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>`;
    }).join('');

    const pivotTableRows = data.map(row => {
      const cells = statusList.map((status, idx) => {
        const count = row.statusCounts[idx];
        return `<td style="background:${count > 0 ? statusColors[status] : '#fff'};">${count}</td>`;
      }).join('');
      return `<tr><td>${row.testerName}</td>${cells}<td><strong>${row.total}</strong></td></tr>`;
    }).join('');

    const now = new Date();
    const pstTime = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: true });
    const istTime = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: true });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>O2C Test Status Report</title>
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      margin: 0;
      padding: 20px;
      line-height: 1.6;
    }
    .container { 
      max-width: 1400px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.15);
      overflow: hidden;
    }
    h1 { 
      color: #ffffff;
      text-align: center;
      margin: 0;
      padding: 40px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      font-size: 2.8rem;
      font-weight: 800;
      text-shadow: 0 4px 8px rgba(0,0,0,0.2);
    }
    h2 { 
      color: #1f2937;
      margin: 40px 0 20px 0;
      font-size: 1.8rem;
      font-weight: 700;
      border-left: 5px solid #667eea;
      padding-left: 15px;
    }
    table { 
      width: 100%;
      border-collapse: collapse;
      margin: 24px 0;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    th, td { 
      padding: 16px;
      text-align: left;
      border-bottom: 1px solid #e5e7eb;
    }
    th { 
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: #ffffff;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-size: 0.9em;
    }
    tr:hover { 
      background: #f0f4ff !important;
      transform: translateY(-1px);
      transition: all 0.2s ease;
    }
    .hidden { display: none; }
    .filter-section { 
      margin: 30px 0;
      padding: 24px;
      background: linear-gradient(135deg, #f8fafc, #e2e8f0);
      border-radius: 16px;
      border: 1px solid #cbd5e1;
      box-shadow: 0 4px 12px rgba(0,0,0,0.05);
    }
    .filter-section select { 
      padding: 12px 16px;
      margin-right: 16px;
      border-radius: 8px;
      border: 2px solid #cbd5e1;
      background: white;
      font-weight: 500;
      transition: all 0.2s ease;
    }
    .filter-section select:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    .aggregate-block { margin-bottom: 40px; }
    .main-content { padding: 40px; }
    .tab-nav { display: flex; background: #f8fafc; border-bottom: 2px solid #e2e8f0; }
    .tab-button {
      flex: 1; padding: 16px 24px; background: transparent; border: none;
      font-size: 1.1em; font-weight: 600; color: #64748b; cursor: pointer;
      transition: all 0.3s ease; border-bottom: 3px solid transparent;
    }
    .tab-button.active {
      color: #00AC69; background: white; border-bottom-color: #00AC69; transform: translateY(-2px);
    }
    .tab-button:hover { color: #00AC69; background: rgba(0, 172, 105, 0.05); }
    .tab-content { display: none; padding: 30px; }
    .tab-content.active { display: block; }
    /* BUG REPORTS MODERN UI */
    .bug-dashboard-header {
      background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%);
      color: white; padding: 40px; border-radius: 16px; margin-bottom: 40px;
      text-align: center; box-shadow: 0 10px 40px rgba(220, 38, 38, 0.2);
    }
    .bug-dashboard-header h2 {
      margin: 0 0 10px 0; color: white; border: none; padding: 0; font-size: 2.5em;
    }
    .bug-dashboard-header p { margin: 10px 0 0 0; font-size: 1.1em; opacity: 0.95; }
    .bug-metrics-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px; margin-bottom: 40px;
    }
    .bug-metric-card {
      background: white; padding: 28px; border-radius: 16px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08); transition: all 0.3s ease;
      border-top: 5px solid; text-align: center;
    }
    .bug-metric-card:hover { transform: translateY(-8px); box-shadow: 0 16px 40px rgba(0,0,0,0.15); }
    .bug-metric-card h3 { margin: 0 0 10px 0; font-size: 1.1em; font-weight: 600; color: #1f2937; }
    .bug-metric-card .count { font-size: 3.5em; font-weight: 900; margin: 10px 0; line-height: 1; }
    .bug-metric-card .label { font-size: 0.9em; opacity: 0.8; font-weight: 500; color: #6b7280; }
    .status-dashboard { background: white; border-radius: 16px; padding: 30px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); margin-bottom: 40px; }
    .status-dashboard h3 { margin-top: 0; color: #1f2937; font-size: 1.5em; margin-bottom: 25px; }
    .modal {
      display: none; position: fixed; z-index: 1000; left: 0; top: 0;
      width: 100%; height: 100%; overflow: auto; background-color: rgba(0,0,0,0.5);
    }
    .modal-content {
      background-color: #fefefe; margin: 5% auto; padding: 20px; border: none;
      border-radius: 12px; width: 90%; max-width: 1000px; max-height: 80vh;
      overflow-y: auto; box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    }
    .close { color: #aaa; float: right; font-size: 28px; font-weight: bold; cursor: pointer; line-height: 1; }
    .close:hover, .close:focus { color: #000; text-decoration: none; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <div class="container">
    <div style="text-align:center; background: linear-gradient(135deg, #00AC69 0%, #1CE783 100%); padding: 60px 40px; position: relative; overflow: hidden;">
      <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: radial-gradient(circle at 20% 80%, rgba(255,255,255,0.15) 0%, transparent 50%), radial-gradient(circle at 80% 20%, rgba(255,255,255,0.15) 0%, transparent 50%);"></div>
      <div style="position: relative; z-index: 2;">
        <h1 style="color: white; font-size: 3rem; font-weight: 900; text-shadow: 0 4px 8px rgba(0,0,0,0.3); letter-spacing: 1px; display: flex; align-items: center; justify-content: center; gap: 20px;">
          <img src="https://github.com/NR-ESEFW/e2e-test-report/raw/main/nr_image_logo.png" alt="New Relic Logo" style="height: 80px;">
          O2C E2E Test Status Report
        </h1>
      </div>
    </div>
    <div class="main-content">
      <p style="text-align:center; color: #6b7280; font-size: 1.1em; margin-bottom: 40px;">
        <strong style="color: #374151;">📊 Report Published on:</strong> 
        <span style="background: #ddd6fe; color: #5b21b6; padding: 4px 8px; border-radius: 6px; font-weight: 600;">🕐 ${pstTime} PST</span> | 
        <span style="background: #ddd6fe; color: #5b21b6; padding: 4px 8px; border-radius: 6px; font-weight: 600;">🕐 ${istTime} IST</span>
      </p>

      <div class="tab-nav">
        <button class="tab-button active" onclick="switchTab('test-results')">🧪 Test Results Dashboard</button>
        ${process.env.ENABLE_BUG_REPORTS === 'true' ? `
        <button class="tab-button" onclick="switchTab('bug-reports')">🐛 Bug Reports Dashboard</button>
        <button class="tab-button" onclick="switchTab('regression-reports')">🔄 O2C Regression</button>` : ''}
        ${process.env.ENABLE_PRORATION_CALC === 'true' ? `<button class="tab-button" onclick="switchTab('proration-calc')">📐 Proration Calculator</button>` : ''}
      </div>

      <!-- TEST RESULTS - 100% UNCHANGED -->
      <div id="test-results" class="tab-content active">
        ${indexStoriesTable}
        <h2>Tester Name × Overall Status</h2>
        <table><thead><tr><th>Tester Name</th>${statusList.map(s => `<th style="background:${statusColors[s] || '#e0e0e0'};color:#222;">${s}</th>`).join('')}<th>Total</th></tr></thead><tbody>${pivotTableRows}</tbody></table>
        <h2>Filter by Tester / Status</h2>
        <div class="filter-section" style="display: grid; grid-template-columns: 1fr 1fr; gap: 30px; padding: 20px; background: #f8fafc; border-radius: 12px; margin-bottom: 30px;">
          <div>
            <h3 style="margin-top: 0; color: #1f2937; font-size: 1.1em;">📋 Select Testers</h3>
            <div id="testerCheckboxes" style="display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto;">
              <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" value="ALL" onchange="filterTesterStatus()" checked> <strong>All Testers</strong></label>
              ${[...new Set(data.map(row => row.testerName))].sort().map(tester => 
                `<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" class="testerCheckbox" value="${tester}" onchange="filterTesterStatus()"> ${tester}</label>`
              ).join('')}
            </div>
          </div>
          <div>
            <h3 style="margin-top: 0; color: #1f2937; font-size: 1.1em;">📊 Select Status</h3>
            <div id="statusCheckboxes" style="display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto;">
              <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" value="ALL" onchange="filterTesterStatus()" checked> <strong>All Statuses</strong></label>
              ${statusList.map(status => 
                `<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" class="statusCheckbox" value="${status}" onchange="filterTesterStatus()" style="accent-color: ${statusColors[status] || '#e0e0e0'};"> <span style="background: ${statusColors[status] || '#e0e0e0'}; padding: 2px 8px; border-radius: 4px; color: white; font-size: 0.9em;">${status}</span></label>`
              ).join('')}
            </div>
          </div>
        </div>
        <div id="noRecordsMessage" style="display: none; text-align: center; padding: 40px 20px; background: linear-gradient(135deg, #f3f4f6, #e5e7eb); border-radius: 12px; margin: 20px 0; border: 2px dashed #d1d5db;">
          <div style="font-size: 3em; color: #9ca3af; margin-bottom: 16px;">🔍</div>
          <h3 style="color: #374151; margin: 0 0 8px 0; font-size: 1.3em;">No Records Found</h3>
          <p style="color: #6b7280; margin: 0; font-size: 1em;">No test results match your current filter criteria. Try adjusting your filters or select "All" to view all results.</p>
        </div>
        <h2>Details by Tester</h2>${aggregateBlocks}
        <h2>Status Counts by Tester</h2><canvas id="testerBarChart" width="800" height="300"></canvas>
        <h2>Status Distribution</h2>
        <div style="display:flex;align-items:center;justify-content:center;gap:40px;flex-wrap:wrap;">
          <canvas id="statusPieChart" width="300" height="300"></canvas>
          <div class="metrics-summary"><h3 style="margin-top:0;">Summary</h3>
            <table style="min-width:250px;"><thead><tr><th>Status</th><th>Count</th><th>%</th></tr></thead><tbody>
              ${statusList.map((status, idx) => {
                const count = statusCounts[idx];
                const total = statusCounts.reduce((a, b) => a + b, 0);
                const percent = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
                const color = statusColors[status] || '#e0e0e0';
                return `<tr><td style="background:${color};font-weight:bold;">${status}</td><td style="text-align:center;font-weight:bold;">${count}</td><td style="text-align:center;">${percent}%</td></tr>`;
              }).join('')}
              <tr style="border-top:2px solid #333;"><td><strong>Total</strong></td><td style="text-align:center;"><strong>${statusCounts.reduce((a, b) => a + b, 0)}</strong></td><td style="text-align:center;"><strong>100%</strong></td></tr>
            </tbody></table>
          </div>
        </div>
      </div>

      ${process.env.ENABLE_BUG_REPORTS === 'true' ? `
      <div id="bug-reports" class="tab-content">${this.generateBugReportsHTML()}</div>
      <div id="regression-reports" class="tab-content">${this.generateRegressionReportsHTML()}</div>` : ''}
      ${process.env.ENABLE_PRORATION_CALC === 'true' ? `<div id="proration-calc" class="tab-content">${this.generateProrationTabHTML()}</div>` : ''}
    </div>
  </div>

  <script>
  function filterTesterStatus() {
    // Get selected testers from checkboxes
    var allTesterCheckbox = document.querySelector('#testerCheckboxes input[value="ALL"]');
    var testerCheckboxes = Array.from(document.querySelectorAll('.testerCheckbox'));
    var selectedTesters = [];
    
    if (allTesterCheckbox && allTesterCheckbox.checked) {
      selectedTesters = ['ALL'];
    } else {
      selectedTesters = testerCheckboxes.filter(cb => cb.checked).map(cb => cb.value);
    }
    
    // Get selected statuses from checkboxes
    var allStatusCheckbox = document.querySelector('#statusCheckboxes input[value="ALL"]');
    var statusCheckboxes = Array.from(document.querySelectorAll('.statusCheckbox'));
    var selectedStatuses = [];
    
    if (allStatusCheckbox && allStatusCheckbox.checked) {
      selectedStatuses = ['ALL'];
    } else {
      selectedStatuses = statusCheckboxes.filter(cb => cb.checked).map(cb => cb.value);
    }
    
    var visibleBlocks = 0, totalVisibleRows = 0;
    document.querySelectorAll('.aggregate-block').forEach(function(block) {
      var blockTester = block.dataset.tester;
      var blockStatuses = (block.dataset.statuses || '').split(',');
      
      var testerMatch = selectedTesters.length === 0 || selectedTesters.includes('ALL') || selectedTesters.includes(blockTester);
      var statusMatch = selectedStatuses.length === 0 || selectedStatuses.includes('ALL') || blockStatuses.some(s => selectedStatuses.includes(s.trim()));
      var showBlock = testerMatch && statusMatch;
      
      if (!showBlock) { block.style.display = 'none'; return; }
      
      var blockHasVisibleRows = false;
      block.style.display = 'block';
      var ticketDetailsContainer = block.querySelector('[data-section="ticket-details"]');
      
      if (ticketDetailsContainer) {
        var ticketRows = ticketDetailsContainer.querySelectorAll('div[data-status]');
        var visibleRowsInBlock = 0;
        ticketRows.forEach(function(row) {
          var rowStatus = (row.getAttribute('data-status') || '').trim();
          var shouldShow = selectedStatuses.includes('ALL') || selectedStatuses.includes(rowStatus) || selectedStatuses.some(s => rowStatus.toUpperCase() === s.toUpperCase());
          if (shouldShow) {
            row.style.display = 'block'; visibleRowsInBlock++; totalVisibleRows++; blockHasVisibleRows = true;
          } else { row.style.display = 'none'; }
        });
        
        var existingEmptyMsg = ticketDetailsContainer.querySelector('.empty-ticket-details');
        if (visibleRowsInBlock === 0 && selectedStatuses.length > 0 && !selectedStatuses.includes('ALL')) {
          if (!existingEmptyMsg) {
            var emptyMsg = document.createElement('div');
            emptyMsg.className = 'empty-ticket-details';
            emptyMsg.style.cssText = 'text-align: center; padding: 20px; color: #6b7280; font-style: italic; background: #f9fafb; border-radius: 8px; border: 1px dashed #d1d5db;';
            emptyMsg.innerHTML = '📭 No results found for selected filters';
            ticketDetailsContainer.appendChild(emptyMsg);
          }
        } else { if (existingEmptyMsg) existingEmptyMsg.remove(); }
      }
      
      var detailTable = block.querySelector('table tbody');
      if (detailTable) {
        detailTable.querySelectorAll('tr').forEach(function(tr) {
          var statusCell = tr.querySelector('td:nth-child(3) span');
          if (statusCell) {
            var rowStatus = statusCell.textContent.trim();
            var shouldShow = selectedStatuses.includes('ALL') || selectedStatuses.includes(rowStatus) || selectedStatuses.some(s => rowStatus.toUpperCase() === s.toUpperCase());
            if (shouldShow) {
              tr.style.display = ''; if (!blockHasVisibleRows) { totalVisibleRows++; blockHasVisibleRows = true; }
            } else { tr.style.display = 'none'; }
          }
        });
      }
      
      if (!blockHasVisibleRows && (selectedTesters.length > 0 || selectedStatuses.length > 0)) { block.style.display = 'none'; }
      else if (blockHasVisibleRows) { visibleBlocks++; }
    });
    
    var noRecordsMsg = document.getElementById('noRecordsMessage');
    var hasFiltersApplied = (selectedTesters.length > 0 && !selectedTesters.includes('ALL')) || (selectedStatuses.length > 0 && !selectedStatuses.includes('ALL'));
    if (noRecordsMsg) { noRecordsMsg.style.display = (hasFiltersApplied && (visibleBlocks === 0 || totalVisibleRows === 0)) ? 'block' : 'none'; }
  }
  function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.querySelectorAll('.tab-button').forEach(button => button.classList.remove('active'));
    document.getElementById(tabName).classList.add('active');
    event.target.classList.add('active');
  }
  window.onload = function() {
    new Chart(document.getElementById('statusPieChart').getContext('2d'), {
      type: 'pie',
      data: { labels: ${JSON.stringify(statusList)}, datasets: [{ data: ${JSON.stringify(statusCounts)}, backgroundColor: ${JSON.stringify(statusList.map(s => statusColors[s] || '#e0e0e0'))} }] },
      options: { plugins: { legend: { position: 'bottom' } } }
    });
    new Chart(document.getElementById('testerBarChart').getContext('2d'), {
      type: 'bar',
      data: { labels: ${JSON.stringify(barLabels)}, datasets: ${JSON.stringify(barDataSets)} },
      options: { plugins: { legend: { position: 'top' } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } }
    });
    ${data.map(row => {
      const group = grouped[row.testerName];
      const testerStatusCounts = Object.values(group.statusCounts);
      const testerStatusLabels = Object.keys(group.statusCounts);
      const testerColors = testerStatusLabels.map(status => statusColors[status] || '#e0e0e0');
      return `try { new Chart(document.getElementById('pieChart-${row.testerName.replace(/\s+/g, '')}').getContext('2d'), {
        type: 'doughnut', data: { labels: ${JSON.stringify(testerStatusLabels)}, datasets: [{ data: ${JSON.stringify(testerStatusCounts)}, backgroundColor: ${JSON.stringify(testerColors)}, borderWidth: 2, borderColor: '#ffffff' }] },
        options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(context) { return context.label + ': ' + context.parsed + ' tickets'; } } } }, maintainAspectRatio: false, responsive: true }
      }); } catch(e) { console.log('Chart error:', e); }`;
    }).join('')}
    window.toggleTesterDetails = function(testerName) {
      const detailsDiv = document.getElementById('details-' + testerName);
      const toggleIcon = document.getElementById('toggle-icon-' + testerName);
      if (detailsDiv.style.maxHeight === '0px' || !detailsDiv.style.maxHeight) {
        detailsDiv.style.maxHeight = detailsDiv.scrollHeight + 'px';
        toggleIcon.style.transform = 'rotate(180deg)';
      } else { detailsDiv.style.maxHeight = '0px'; toggleIcon.style.transform = 'rotate(0deg)'; }
    };
  };
  </script>
  <div id="ticketModal" class="modal"><div class="modal-content"><span class="close" onclick="closeModal()">&times;</span><h2 id="modalTitle">Ticket Details</h2><div id="modalContent">Loading...</div></div></div>
</body>
</html>`;
  }

  async fetchJiraIssues() {
    try {
      console.log('🐛 Fetching JIRA issues from 3 queries (5000 limit per query)...');
      if (!process.env.JIRA_BASE_URL || !process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
        throw new Error('Missing JIRA credentials in .env file');
      }
      
      const jiraAuth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
      const jiraUrl = `${process.env.JIRA_BASE_URL.replace(/\/$/, '')}/rest/api/3/search/jql`;
      
      // Use display names instead of UUIDs for better compatibility
      const teamMemberNames = [
        'Veeraraghava Thogaru',
        'Gary Bermudez Mora',
        'Harshawardhan Reddy',
        'Latheesh Parisineti',
        'Pushpa Belvatta',
        'Rama Chavali',
        'Sonali Gupta',
        'Venkata Thota'
      ];
      const assigneeQueryPart = teamMemberNames.map(name => `assignee = "${name}"`).join(' OR ');
      const reporterQueryPart = teamMemberNames.map(name => `reporter = "${name}"`).join(' OR ');
      
      // Log the exact queries for debugging
      console.log('\n🔍 DEBUG: Team member names:');
      teamMemberNames.forEach(name => console.log(`   - ${name}`));
      console.log('\n🔍 DEBUG: Assignee query part:');
      console.log(`   ${assigneeQueryPart.substring(0, 150)}...`);
      console.log('\n🔍 DEBUG: Reporter query part:');
      console.log(`   ${reporterQueryPart.substring(0, 150)}...`);
      
      // Query 1: Current Bugs with e2e_o2c_bugs label - Ready for QA & QA status (working filter)
      console.log('📍 Query 1: Fetching Current Bugs (e2e_o2c_bugs label, Ready for QA / QA status)...');
      const currentBugs = await this.fetchJiraQuery(jiraUrl, jiraAuth, 
        `project = "NR" AND type = "BA QA Issue" AND labels = e2e_o2c_bugs AND (status = "Ready for QA" OR status = "QA") ORDER BY priority DESC, created DESC`, 5000);
      this.currentBugs = currentBugs.sort((a, b) => a.assignee.localeCompare(b.assignee));
      console.log(`✅ Current Bugs: ${currentBugs.length} issues with e2e_o2c_bugs label`);
      
      // Query 2: Assigned Bugs - ONLY e2e_o2c_bugs label with CORRECT team member UUIDs
      console.log('📍 Query 2: Fetching Assigned Bugs (e2e_o2c_bugs label only)...');
      const assignedBugs = await this.fetchJiraQuery(jiraUrl, jiraAuth,
        `project = "NR" AND type = "BA QA Issue" AND labels = e2e_o2c_bugs AND assignee IN (712020:bae768ad-800f-4c4e-8edf-f8424131bd83, 712020:5590d4ea-153b-4a91-8bbf-ae3c410e9612, 712020:e61ac3c9-73c5-4f39-a30d-11a5ab0c68fc, 712020:fcda8681-af32-4156-bc95-320347316dc3, 557058:7c2a964a-d726-4960-906c-dbd60f1e0c4e, 712020:3c8b3a4e-afcc-4e9c-8ec7-0090eb1ddb60, 712020:bf4d1ab0-b6d6-47a2-bc1c-58178d04421d, 712020:aaeb1218-5964-4a80-845e-9cb314f6f232) ORDER BY created DESC`, 5000);
      
      // Deduplicate by bug ID
      const uniqueAssignedIds = new Set(assignedBugs.map(b => b.id));
      const deduplicatedAssignedBugs = Array.from(uniqueAssignedIds).map(id => assignedBugs.find(b => b.id === id));
      
      this.assignedBugs = deduplicatedAssignedBugs.sort((a, b) => (a.assignee || '').localeCompare(b.assignee || ''));
      console.log(`✅ Assigned Bugs (e2e_o2c_bugs only): ${deduplicatedAssignedBugs.length} unique issues`);
      
      // Query 3: Reporter Bugs - ONLY e2e_o2c_bugs label with CORRECT team member UUIDs
      console.log('📍 Query 3: Fetching Reporter Bugs (e2e_o2c_bugs label only)...');
      const reporterBugs = await this.fetchJiraQuery(jiraUrl, jiraAuth,
        `project = "NR" AND type = "BA QA Issue" AND labels = e2e_o2c_bugs AND reporter IN (712020:bae768ad-800f-4c4e-8edf-f8424131bd83, 712020:5590d4ea-153b-4a91-8bbf-ae3c410e9612, 712020:e61ac3c9-73c5-4f39-a30d-11a5ab0c68fc, 712020:fcda8681-af32-4156-bc95-320347316dc3, 557058:7c2a964a-d726-4960-906c-dbd60f1e0c4e, 712020:3c8b3a4e-afcc-4e9c-8ec7-0090eb1ddb60, 712020:bf4d1ab0-b6d6-47a2-bc1c-58178d04421d, 712020:aaeb1218-5964-4a80-845e-9cb314f6f232) ORDER BY created DESC`, 5000);
      
      // Deduplicate by bug ID
      const uniqueReporterIds = new Set(reporterBugs.map(b => b.id));
      const deduplicatedReporterBugs = Array.from(uniqueReporterIds).map(id => reporterBugs.find(b => b.id === id));
      
      this.reporterBugs = deduplicatedReporterBugs.sort((a, b) => (a.reporter || '').localeCompare(b.reporter || ''));
      console.log(`✅ Reporter Bugs (e2e_o2c_bugs only): ${deduplicatedReporterBugs.length} unique issues`);
      
      // Combine all bugs for general metrics
      const allIssuesSet = new Set([...currentBugs, ...assignedBugs, ...reporterBugs].map(b => b.id));
      this.jiraBugs = Array.from(allIssuesSet).map(id => {
        const bug = [...currentBugs, ...assignedBugs, ...reporterBugs].find(b => b.id === id);
        return bug;
      }).slice(0, 5000);
      
      this.generateBugMetrics();
      
    } catch (error) {
      console.error('❌ Error fetching JIRA issues:', error.response?.data || error.message);
      console.log('🔄 Using empty data...');
      this.currentBugs = [];
      this.assignedBugs = [];
      this.reporterBugs = [];
      this.jiraBugs = [];
      this.generateBugMetrics();
    }
  }

  async fetchJiraQuery(jiraUrl, jiraAuth, jql, maxLimit = 5000) {
    try {
      let allIssues = [];
      let startAt = 0;
      const maxResults = 100;
      let isLast = false;
      
      do {
        const response = await axios({
          method: 'GET',
          url: jiraUrl,
          headers: {
            'Authorization': `Basic ${jiraAuth}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          params: {
            jql: jql,
            startAt: startAt,
            maxResults: maxResults,
            fields: 'key,summary,priority,status,reporter,assignee,created,updated,labels'
          },
          timeout: 30000
        });
        
        const issues = response.data.issues || [];
        isLast = response.data.isLast !== false;
        allIssues = allIssues.concat(issues);
        startAt += maxResults;
        
        console.log(`   📥 Fetched batch: ${issues.length} issues (${allIssues.length} total so far)`);
        
        if (allIssues.length >= maxLimit) break;
      } while (!isLast && allIssues.length < maxLimit);
      
      return allIssues.map(issue => ({
        id: issue.key,
        summary: issue.fields.summary || 'No summary',
        priority: issue.fields.priority?.name || 'Medium',
        status: issue.fields.status?.name || 'Open',
        reporter: issue.fields.creator?.displayName || issue.fields.reporter?.displayName || 'Unknown',
        reporterEmail: issue.fields.creator?.emailAddress || '',
        assignee: issue.fields.assignee?.displayName || 'Unassigned',
        assigneeEmail: issue.fields.assignee?.emailAddress || '',
        labels: issue.fields.labels || [],
        created: new Date(issue.fields.created).toLocaleDateString(),
        updated: new Date(issue.fields.updated).toLocaleDateString()
      }));
    } catch (error) {
      console.warn(`⚠️ Query failed: ${error.message}`);
      return [];
    }
  }

  generateBugMetrics() {
    this.bugMetrics.priorities = this.jiraBugs.reduce((acc, bug) => {
      acc[bug.priority] = (acc[bug.priority] || 0) + 1;
      return acc;
    }, {});
    this.bugMetrics.statuses = this.jiraBugs.reduce((acc, bug) => {
      acc[bug.status] = (acc[bug.status] || 0) + 1;
      return acc;
    }, {});
  }

  generateBugReportsHTML() {
    const currentBugs = this.currentBugs || [];
    const allAssignedBugs = this.assignedBugs || [];
    const allReporterBugs = this.reporterBugs || [];

    // ESE Framework Team Members (ALL 7) - with email fallback
    const allTeamMembers = [
      'Veeraraghava Thogaru',
      'Gary Bermudez Mora',
      'Latheesh Parisineti',
      'Pushpa Belvatta',
      'Sonali Gupta',
      'Harshawardhan Reddy',
      'Rama Chavali',
      'Venkata Thota'
    ].sort();

    // Filter bugs to ONLY include team members (remove Harshawardhan, etc.)
    const assignedBugs = allAssignedBugs.filter(bug => 
      allTeamMembers.includes(bug.assignee || 'Unknown')
    );
    const reporterBugs = allReporterBugs.filter(bug => 
      allTeamMembers.includes(bug.reporter || 'Unknown')
    );

    // Get unique team members from the filtered bug data
    const assigneeNames = [...new Set(assignedBugs.map(b => b.assignee || 'Unknown'))].sort();
    const reporterNames = [...new Set(reporterBugs.map(b => b.reporter || 'Unknown'))].sort();

    // First: Deduplicate bugs by ID (remove duplicates from multiple labels)
    const uniqueBugsByAssignee = {};
    assignedBugs.forEach(bug => {
      if (!uniqueBugsByAssignee[bug.assignee]) {
        uniqueBugsByAssignee[bug.assignee] = {};
      }
      // Only add if not seen before (by bug ID)
      if (!uniqueBugsByAssignee[bug.assignee][bug.id]) {
        uniqueBugsByAssignee[bug.assignee][bug.id] = bug;
      }
    });

    // Second: Convert back to array and group by priority
    const groupAssigneeByPriority = (bugs) => {
      const groups = {};
      
      // Initialize ALL team members
      allTeamMembers.forEach(name => {
        groups[name] = {};
      });
      assigneeNames.forEach(name => {
        if (!groups[name]) groups[name] = {};
      });
      
      // Group unique bugs by priority
      Object.entries(uniqueBugsByAssignee).forEach(([assignee, bugMap]) => {
        if (!groups[assignee]) groups[assignee] = {};
        Object.values(bugMap).forEach(bug => {
          const priority = bug.priority || 'No Priority';
          if (!groups[assignee][priority]) groups[assignee][priority] = [];
          groups[assignee][priority].push(bug);
        });
      });
      
      return groups;
    };

    // Group reporter by priority (similar logic)
    const uniqueBugsByReporter = {};
    reporterBugs.forEach(bug => {
      if (!uniqueBugsByReporter[bug.reporter]) {
        uniqueBugsByReporter[bug.reporter] = {};
      }
      // Only add if not seen before (by bug ID)
      if (!uniqueBugsByReporter[bug.reporter][bug.id]) {
        uniqueBugsByReporter[bug.reporter][bug.id] = bug;
      }
    });

    const groupReporterByPriority = (bugs) => {
      const groups = {};
      
      // Initialize ALL team members
      allTeamMembers.forEach(name => {
        groups[name] = {};
      });
      reporterNames.forEach(name => {
        if (!groups[name]) groups[name] = {};
      });
      
      // Group unique bugs by priority
      Object.entries(uniqueBugsByReporter).forEach(([reporter, bugMap]) => {
        if (!groups[reporter]) groups[reporter] = {};
        Object.values(bugMap).forEach(bug => {
          const priority = bug.priority || 'No Priority';
          if (!groups[reporter][priority]) groups[reporter][priority] = [];
          groups[reporter][priority].push(bug);
        });
      });
      
      return groups;
    };

    const assignedByPriority = groupAssigneeByPriority(assignedBugs);
    const reporterByPriority = groupReporterByPriority(reporterBugs);

    const qaCount = currentBugs.filter(b => b.status === 'QA').length;
    const readyCount = currentBugs.filter(b => b.status === 'Ready for QA').length;

    // Build assignee cards with priority segregation and granular bug tracking
    let assignedCardsHTML = '';
    Object.entries(assignedByPriority).forEach(([assignee, priorityData]) => {
      // Only show if assignee is in allTeamMembers (filter out wrong people like Harshawardhan)
      if (!allTeamMembers.includes(assignee)) {
        return;  // Skip this person
      }
      
      // Count unique bugs by ID (deduplicate)
      const uniqueBugIds = new Set();
      Object.values(priorityData).forEach(bugs => {
        bugs.forEach(bug => uniqueBugIds.add(bug.id));
      });
      const total = uniqueBugIds.size;
      
      const initials = assignee.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
      const cardColor = total === 0 ? '#e5e7eb' : (total < 50 ? '#86efac' : (total < 150 ? '#fbbf24' : '#ef4444'));
      
      assignedCardsHTML += '<div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 16px; border-left: 4px solid ' + cardColor + ';">';
      
      // Header
      assignedCardsHTML += '<div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">';
      assignedCardsHTML += '<div style="width: 48px; height: 48px; background: linear-gradient(135deg, #7c3aed, #6d28d9); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-weight: 700; font-size: 1em;">' + initials + '</div>';
      assignedCardsHTML += '<div><div style="font-weight: 700; color: #1f2937; font-size: 1.1em;">' + assignee + '</div><div style="color: #666; font-size: 0.9em;">Assigned Bugs: ' + total + '</div></div>';
      assignedCardsHTML += '</div>';
      
      // Wagon bar
      assignedCardsHTML += '<div style="margin-bottom: 12px;">';
      assignedCardsHTML += '<div style="width: 100%; height: 24px; background: #e5e7eb; border-radius: 12px; overflow: hidden;">';
      const percentage = Math.min((total / 200) * 100, 100);
      assignedCardsHTML += '<div style="width: ' + percentage + '%; height: 100%; background: linear-gradient(90deg, #7c3aed 0%, #a855f7 100%);"></div>';
      assignedCardsHTML += '</div></div>';
      
      // Priority sections
      if (total === 0) {
        assignedCardsHTML += '<div style="color: #999; font-style: italic; font-size: 0.9em;">No bugs assigned</div>';
      } else {
        const priorityOrder = { 'Highest': 0, 'High': 1, 'Medium': 2, 'Low': 3, 'Lowest': 4 };
        const sortedPriorities = Object.entries(priorityData)
          .filter(([_, bugs]) => bugs.length > 0)
          .sort((a, b) => (priorityOrder[a[0]] || 999) - (priorityOrder[b[0]] || 999));
        
        sortedPriorities.forEach(([priority, bugs]) => {
          const priorityColors = { 'Highest': '#dc2626', 'High': '#ea580c', 'Medium': '#f59e0b', 'Low': '#10b981', 'Lowest': '#6b7280', 'No Priority': '#9ca3af' };
          const bgColor = priorityColors[priority] || '#6b7280';
          const sectionId = 'assigned_' + assignee.replace(/\s/g, '_') + '_' + priority.replace(/\s/g, '_');
          
          // Priority header
          assignedCardsHTML += '<div style="background: #f3f4f6; padding: 10px; margin-top: 12px; cursor: pointer; border-radius: 6px; user-select: none;" onclick="var el = document.getElementById(\'' + sectionId + '\'); el.style.display = el.style.display === \'none\' ? \'block\' : \'none\'; this.textContent = this.textContent.includes(\'▼\') ? \'▶ \' + this.textContent.substring(2) : \'▼ \' + this.textContent.substring(2);">';
          assignedCardsHTML += '▼ <span style="background: ' + bgColor + '; color: white; padding: 2px 8px; border-radius: 3px; font-weight: 600; font-size: 0.8em;">' + priority + '</span> ' + bugs.length + ' bugs';
          assignedCardsHTML += '</div>';
          
          // Bug table (hidden by default)
          assignedCardsHTML += '<div id="' + sectionId + '" style="display: none; margin-top: 10px;">';
          assignedCardsHTML += '<table style="width: 100%; border-collapse: collapse; font-size: 0.9em;">';
          assignedCardsHTML += '<thead><tr style="background: #f9fafb; border-bottom: 2px solid #e5e7eb;"><th style="padding: 8px; text-align: left; font-weight: 600;">Key</th><th style="padding: 8px; text-align: left; font-weight: 600;">Summary</th><th style="padding: 8px; text-align: left; font-weight: 600;">Status</th><th style="padding: 8px; text-align: left; font-weight: 600;">Created</th><th style="padding: 8px; text-align: left; font-weight: 600;">Updated</th><th style="padding: 8px; text-align: left; font-weight: 600;">Link</th></tr></thead>';
          assignedCardsHTML += '<tbody>';
          
          bugs.forEach((bug, index) => {
            const statusColors = { 'Closed': '#10b981', 'QA': '#f59e0b', 'Ready for QA': '#eab308', 'Open': '#3b82f6', 'In Progress': '#8b5cf6', 'Done': '#06b6d4' };
            const statusBg = statusColors[bug.status] || '#6b7280';
            assignedCardsHTML += '<tr style="border-bottom: 1px solid #e5e7eb;">';
            assignedCardsHTML += '<td style="padding: 8px;"><span style="color: #7c3aed; font-weight: 600;">' + bug.id + '</span></td>';
            assignedCardsHTML += '<td style="padding: 8px;">' + (bug.summary ? bug.summary.substring(0, 40) + (bug.summary.length > 40 ? '...' : '') : 'No summary') + '</td>';
            assignedCardsHTML += '<td style="padding: 8px;"><span style="background: ' + statusBg + '; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; font-weight: 600;">' + bug.status + '</span></td>';
            assignedCardsHTML += '<td style="padding: 8px; font-size: 0.85em;">' + bug.created + '</td>';
            assignedCardsHTML += '<td style="padding: 8px; font-size: 0.85em;">' + bug.updated + '</td>';
            assignedCardsHTML += '<td style="padding: 8px;"><a href="https://new-relic.atlassian.net/browse/' + bug.id + '" target="_blank" style="color: #7c3aed; text-decoration: none; font-weight: 600;">View</a></td>';
            assignedCardsHTML += '</tr>';
            
            if (index === 2 && bugs.length > 3) {
              assignedCardsHTML += '<tr><td colspan="6" style="padding: 8px; text-align: center;"><button onclick="this.parentElement.parentElement.style.display=\'none\'; this.parentElement.parentElement.nextElementSibling.style.display=\'table-row-group\';" style="background: #f3f4f6; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; color: #7c3aed; font-weight: 600;">Show ' + (bugs.length - 3) + ' more bugs</button></td></tr>';
              assignedCardsHTML += '<tbody style="display: none;">';
            }
          });
          
          if (bugs.length > 3) {
            assignedCardsHTML += '</tbody>';
          }
          assignedCardsHTML += '</tbody></table>';
          assignedCardsHTML += '</div>';
        });
      }
      
      assignedCardsHTML += '</div>';
    });
    
    // Build reporter cards with priority segregation and granular bug tracking
    let reporterCardsHTML = '';
    Object.entries(reporterByPriority).forEach(([reporter, priorityData]) => {
      // Only show if reporter is in allTeamMembers (filter out wrong people)
      if (!allTeamMembers.includes(reporter)) {
        return;  // Skip this person
      }
      
      // Count unique bugs by ID (deduplicate)
      const uniqueBugIds = new Set();
      Object.values(priorityData).forEach(bugs => {
        bugs.forEach(bug => uniqueBugIds.add(bug.id));
      });
      const total = uniqueBugIds.size;
      
      const initials = reporter.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
      const cardColor = total === 0 ? '#e5e7eb' : (total < 20 ? '#86efac' : (total < 50 ? '#fbbf24' : '#ef4444'));
      
      reporterCardsHTML += '<div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 16px; border-left: 4px solid ' + cardColor + ';">';
      
      // Header
      reporterCardsHTML += '<div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">';
      reporterCardsHTML += '<div style="width: 48px; height: 48px; background: linear-gradient(135deg, #0891b2, #0e7490); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-weight: 700; font-size: 1em;">' + initials + '</div>';
      reporterCardsHTML += '<div><div style="font-weight: 700; color: #1f2937; font-size: 1.1em;">' + reporter + '</div><div style="color: #666; font-size: 0.9em;">Reported Bugs: ' + total + '</div></div>';
      reporterCardsHTML += '</div>';
      
      // Wagon bar
      reporterCardsHTML += '<div style="margin-bottom: 12px;">';
      reporterCardsHTML += '<div style="width: 100%; height: 24px; background: #e5e7eb; border-radius: 12px; overflow: hidden;">';
      const percentage = Math.min((total / 100) * 100, 100);
      reporterCardsHTML += '<div style="width: ' + percentage + '%; height: 100%; background: linear-gradient(90deg, #06b6d4 0%, #14b8a6 100%);"></div>';
      reporterCardsHTML += '</div></div>';
      
      // Priority sections
      if (total === 0) {
        reporterCardsHTML += '<div style="color: #999; font-style: italic; font-size: 0.9em;">No bugs reported</div>';
      } else {
        const priorityOrder = { 'Highest': 0, 'High': 1, 'Medium': 2, 'Low': 3, 'Lowest': 4 };
        const sortedPriorities = Object.entries(priorityData)
          .filter(([_, bugs]) => bugs.length > 0)
          .sort((a, b) => (priorityOrder[a[0]] || 999) - (priorityOrder[b[0]] || 999));
        
        sortedPriorities.forEach(([priority, bugs]) => {
          const priorityColors = { 'Highest': '#dc2626', 'High': '#ea580c', 'Medium': '#f59e0b', 'Low': '#10b981', 'Lowest': '#6b7280', 'No Priority': '#9ca3af' };
          const bgColor = priorityColors[priority] || '#6b7280';
          const sectionId = 'reporter_' + reporter.replace(/\s/g, '_') + '_' + priority.replace(/\s/g, '_');
          
          // Priority header
          reporterCardsHTML += '<div style="background: #f3f4f6; padding: 10px; margin-top: 12px; cursor: pointer; border-radius: 6px; user-select: none;" onclick="var el = document.getElementById(\'' + sectionId + '\'); el.style.display = el.style.display === \'none\' ? \'block\' : \'none\'; this.textContent = this.textContent.includes(\'▼\') ? \'▶ \' + this.textContent.substring(2) : \'▼ \' + this.textContent.substring(2);">';
          reporterCardsHTML += '▼ <span style="background: ' + bgColor + '; color: white; padding: 2px 8px; border-radius: 3px; font-weight: 600; font-size: 0.8em;">' + priority + '</span> ' + bugs.length + ' bugs';
          reporterCardsHTML += '</div>';
          
          // Bug table (hidden by default)
          reporterCardsHTML += '<div id="' + sectionId + '" style="display: none; margin-top: 10px;">';
          reporterCardsHTML += '<table style="width: 100%; border-collapse: collapse; font-size: 0.9em;">';
          reporterCardsHTML += '<thead><tr style="background: #f9fafb; border-bottom: 2px solid #e5e7eb;"><th style="padding: 8px; text-align: left; font-weight: 600;">Key</th><th style="padding: 8px; text-align: left; font-weight: 600;">Summary</th><th style="padding: 8px; text-align: left; font-weight: 600;">Status</th><th style="padding: 8px; text-align: left; font-weight: 600;">Created</th><th style="padding: 8px; text-align: left; font-weight: 600;">Updated</th><th style="padding: 8px; text-align: left; font-weight: 600;">Link</th></tr></thead>';
          reporterCardsHTML += '<tbody>';
          
          bugs.forEach((bug, index) => {
            const statusColors = { 'Closed': '#10b981', 'QA': '#f59e0b', 'Ready for QA': '#eab308', 'Open': '#3b82f6', 'In Progress': '#8b5cf6', 'Done': '#06b6d4' };
            const statusBg = statusColors[bug.status] || '#6b7280';
            reporterCardsHTML += '<tr style="border-bottom: 1px solid #e5e7eb;">';
            reporterCardsHTML += '<td style="padding: 8px;"><span style="color: #0891b2; font-weight: 600;">' + bug.id + '</span></td>';
            reporterCardsHTML += '<td style="padding: 8px;">' + (bug.summary ? bug.summary.substring(0, 40) + (bug.summary.length > 40 ? '...' : '') : 'No summary') + '</td>';
            reporterCardsHTML += '<td style="padding: 8px;"><span style="background: ' + statusBg + '; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; font-weight: 600;">' + bug.status + '</span></td>';
            reporterCardsHTML += '<td style="padding: 8px; font-size: 0.85em;">' + bug.created + '</td>';
            reporterCardsHTML += '<td style="padding: 8px; font-size: 0.85em;">' + bug.updated + '</td>';
            reporterCardsHTML += '<td style="padding: 8px;"><a href="https://new-relic.atlassian.net/browse/' + bug.id + '" target="_blank" style="color: #0891b2; text-decoration: none; font-weight: 600;">View</a></td>';
            reporterCardsHTML += '</tr>';
            
            if (index === 2 && bugs.length > 3) {
              reporterCardsHTML += '<tr><td colspan="6" style="padding: 8px; text-align: center;"><button onclick="this.parentElement.parentElement.style.display=\'none\'; this.parentElement.parentElement.nextElementSibling.style.display=\'table-row-group\';" style="background: #f3f4f6; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; color: #0891b2; font-weight: 600;">Show ' + (bugs.length - 3) + ' more bugs</button></td></tr>';
              reporterCardsHTML += '<tbody style="display: none;">';
            }
          });
          
          if (bugs.length > 3) {
            reporterCardsHTML += '</tbody>';
          }
          reporterCardsHTML += '</tbody></table>';
          reporterCardsHTML += '</div>';
        });
      }
      
      reporterCardsHTML += '</div>';
    });

        let html = `
    <style>
      .kpi-container {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
        gap: 20px;
        margin-bottom: 40px;
      }
      .kpi-card {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 24px;
        border-radius: 12px;
        box-shadow: 0 4px 15px rgba(0,0,0,0.1);
        text-align: center;
      }
      .kpi-card.red {
        background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%);
      }
      .kpi-card.yellow {
        background: linear-gradient(135deg, #ca8a04 0%, #92400e 100%);
      }
      .kpi-card.blue {
        background: linear-gradient(135deg, #0891b2 0%, #0e7490 100%);
      }
      .kpi-value {
        font-size: 2.5em;
        font-weight: 800;
        margin: 10px 0;
      }
      .kpi-label {
        font-size: 0.9em;
        opacity: 0.9;
        text-transform: uppercase;
        letter-spacing: 1px;
      }
    </style>

    <div class="kpi-container">
      <div class="kpi-card red">
        <div class="kpi-label">🔴 Current Bugs (e2e_o2c_bugs)</div>
        <div class="kpi-value">${currentBugs.length}</div>
      </div>
      <div class="kpi-card yellow">
        <div class="kpi-label">🟡 Ready for QA</div>
        <div class="kpi-value">${readyCount}</div>
      </div>
      <div class="kpi-card red">
        <div class="kpi-label">🟠 In QA</div>
        <div class="kpi-value">${qaCount}</div>
      </div>
      <div class="kpi-card blue">
        <div class="kpi-label">👥 Assigned (Unique)</div>
        <div class="kpi-value">${new Set(assignedBugs.map(b => b.id)).size}</div>
      </div>
      <div class="kpi-card" style="background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);">
        <div class="kpi-label">📝 Reported (Unique)</div>
        <div class="kpi-value">${new Set(reporterBugs.map(b => b.id)).size}</div>
      </div>
    </div>

    <div class="bug-dashboard-header" style="background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); margin-bottom: 40px;">
      <h2 style="margin: 0; color: white; border: none; padding: 0; font-size: 2.2em;">🔴 CURRENT BUGS FOCUS (e2e_o2c_bugs)</h2>
      <p style="margin: 10px 0 0 0; font-size: 1em; opacity: 0.95;">Ready for QA & QA Status • Action Items</p>
    </div>

    <div style="background: white; padding: 24px; border-radius: 12px; margin-bottom: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
      <table style="width: 100%;">
        <tr style="border-bottom: 2px solid #e5e7eb;">
          <th style="padding: 12px; text-align: left; font-weight: 700;">STATUS</th>
          <th style="padding: 12px; text-align: center; font-weight: 700;">COUNT</th>
          <th style="padding: 12px; text-align: center; font-weight: 700;">%</th>
        </tr>
        <tr style="border-bottom: 1px solid #e5e7eb;">
          <td style="padding: 12px;"><span style="background: #ea580c; color: white; padding: 6px 12px; border-radius: 6px;">🟠 QA</span></td>
          <td style="padding: 12px; text-align: center; font-weight: 700;">${qaCount}</td>
          <td style="padding: 12px; text-align: center;">${currentBugs.length > 0 ? ((qaCount/currentBugs.length)*100).toFixed(1) : 0}%</td>
        </tr>
        <tr>
          <td style="padding: 12px;"><span style="background: #ca8a04; color: white; padding: 6px 12px; border-radius: 6px;">🟡 Ready for QA</span></td>
          <td style="padding: 12px; text-align: center; font-weight: 700;">${readyCount}</td>
          <td style="padding: 12px; text-align: center;">${currentBugs.length > 0 ? ((readyCount/currentBugs.length)*100).toFixed(1) : 0}%</td>
        </tr>
      </table>
    </div>

    <div class="bug-dashboard-header" style="background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%); margin: 60px 0 40px 0;">
      <h2 style="margin: 0; color: white; border: none; padding: 0; font-size: 2.2em;">👥 BUGS ASSIGNED TO TEAM - Individual Cards</h2>
      <p style="margin: 10px 0 0 0; font-size: 1em; opacity: 0.95;">Each team member with workload & distribution</p>
    </div>

    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px; margin-bottom: 40px;">
      ${assignedCardsHTML}
    </div>

    <div class="bug-dashboard-header" style="background: linear-gradient(135deg, #0891b2 0%, #0e7490 100%); margin: 60px 0 40px 0;">
      <h2 style="margin: 0; color: white; border: none; padding: 0; font-size: 2.2em;">📝 BUGS REPORTED BY TEAM - Individual Cards</h2>
      <p style="margin: 10px 0 0 0; font-size: 1em; opacity: 0.95;">Each team member's quality contribution</p>
    </div>

    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px; margin-bottom: 40px;">
      ${reporterCardsHTML}
    </div>
    `;

    return html;
  }
  generateRegressionReportsHTML() {
    const rc = this.jiraBugs.filter(b => (b.labels || []).includes('o2c_regression')).length;
    const rp1 = this.jiraBugs.filter(b => (b.labels || []).includes('o2c_regression') && ['Critical', 'Blocker'].includes(b.priority)).length;
    const rp2 = this.jiraBugs.filter(b => (b.labels || []).includes('o2c_regression') && ['High', 'Major'].includes(b.priority)).length;
    const rp3 = this.jiraBugs.filter(b => (b.labels || []).includes('o2c_regression') && b.priority === 'Medium').length;
    const rp4 = this.jiraBugs.filter(b => (b.labels || []).includes('o2c_regression') && ['Low', 'Minor'].includes(b.priority)).length;
    return `
    <div class="bug-dashboard-header" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);"><h2>🔄 O2C Regression Dashboard</h2><p>Regression Tracking • Quality Focus • Total: ${rc} tickets</p></div>
    <div class="bug-metrics-grid">
      <div class="bug-metric-card" style="border-top-color: #dc2626;"><h3>🔴 Critical</h3><div class="count">${rp1}</div><div class="label">Regression</div></div>
      <div class="bug-metric-card" style="border-top-color: #ea580c;"><h3>🟠 High</h3><div class="count">${rp2}</div><div class="label">Regression</div></div>
      <div class="bug-metric-card" style="border-top-color: #ca8a04;"><h3>🟡 Medium</h3><div class="count">${rp3}</div><div class="label">Regression</div></div>
      <div class="bug-metric-card" style="border-top-color: #16a34a;"><h3>🟢 Low</h3><div class="count">${rp4}</div><div class="label">Regression</div></div>
    </div>
    <div class="status-dashboard">
      <h3>📈 Regression Overview</h3>
      <p style="color: #6b7280; font-style: italic; margin: 0 0 20px 0;">O2C regression issues with priority tracking.</p>
      <table style="width: 100%; border-collapse: collapse;">
        <thead><tr style="background: linear-gradient(135deg, #f59e0b, #d97706); color: white;"><th style="padding: 15px; text-align: left; font-weight: 700;">METRIC</th><th style="padding: 15px; text-align: center; font-weight: 700;">COUNT</th></tr></thead>
        <tbody><tr><td style="padding: 15px; font-weight: 600;">Total Regression Issues</td><td style="padding: 15px; text-align: center; background: #f59e0b; color: white; font-weight: 700; font-size: 1.2em;">${rc}</td></tr></tbody>
      </table>
    </div>`;
  }

  generateProrationTabHTML() {
    return `<style>.proration-tab-wrap { display: flex; flex-direction: column; height: calc(100vh - 160px); border-radius: 12px; overflow: hidden; border: 1.5px solid rgba(0, 172, 105, 0.25); background: #0c0f18; } .proration-tab-topbar { display: flex; align-items: center; justify-content: space-between; padding: 10px 18px; background: linear-gradient(135deg, #071a10, #0c0f18); border-bottom: 1px solid rgba(0, 172, 105, 0.2); flex-shrink: 0; } .proration-tab-title { display: flex; align-items: center; gap: 10px; font-size: 0.85rem; font-weight: 700; color: #1CE783; font-family: 'IBM Plex Mono', monospace; } .proration-tab-btn { padding: 6px 14px; border-radius: 7px; border: 1.5px solid; font-size: 0.75rem; font-weight: 700; cursor: pointer; font-family: 'IBM Plex Mono', monospace; } .proration-tab-btn.outline { border-color: rgba(0, 172, 105, 0.35); color: #1CE783; background: transparent; } .proration-tab-btn.solid { border-color: #00AC69; background: linear-gradient(135deg, #00AC69, #1CE783); color: #000; } .proration-tab-iframe { flex: 1; width: 100%; border: none; background: #0c0f18; }</style>
    <div class="proration-tab-wrap"><div class="proration-tab-topbar"><div class="proration-tab-title">📐 Proration Calculator · proration-v2.html</div><div style="display: flex; gap: 8px;"><button class="proration-tab-btn outline" onclick="document.getElementById('proration-iframe').src = document.getElementById('proration-iframe').src">🔄 Reload</button><a class="proration-tab-btn solid" href="./proration-v2.html" target="_blank">↗ Open Full</a></div></div><iframe id="proration-iframe" class="proration-tab-iframe" src="./proration-v2.html"></iframe></div>`;
  }

  saveReports() {
    const html = this.generateHTMLReport();
    fs.writeFileSync('o2c-test-status-report.html', html, 'utf8');
    return { htmlPath: 'o2c-test-status-report.html' };
  }
}

export default GoogleSheetsPivotReporterOAuth;

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      const authCode = process.env.GOOGLE_AUTH_CODE || process.argv[2];
      if (!spreadsheetId) { console.error('❌ Set GOOGLE_SHEETS_SPREADSHEET_ID environment variable'); process.exit(1); }
      const reporter = new GoogleSheetsPivotReporterOAuth(spreadsheetId);
      await reporter.authenticate(authCode);
      await reporter.fetchAllSheetsData();
      await reporter.fetchJiraIssues();
      const { htmlPath } = reporter.saveReports();
      console.log(`✅ Report saved: ${path.resolve(htmlPath)}`);
    } catch (err) {
      console.error('❌ Error:', err.message);
      process.exit(1);
    }
  })();
}
