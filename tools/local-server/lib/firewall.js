'use strict';

// Windows Firewall, for Foxy Timer for Windows: can phones and screens on the
// show network reach this laptop's server? The usual failure is silent - the
// laptop sees the dashboard, other devices just time out - because Windows
// blocks inbound connections to a program unless it's allowed, and Wi-Fi is
// often classed as a *Public* network, where an "Allow on private networks"
// answer to Windows' prompt doesn't apply. Pressing Cancel on that prompt
// leaves Block rules, which beat any Allow rule.
//
// evaluate() is pure (tested); checkFirewall()/allowThroughFirewall() gather
// the facts / make the change via PowerShell, by full path.

const path = require('path');
const { execFile } = require('child_process');

const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

// Windows' NetworkCategory -> the firewall profile name a rule lists.
const CATEGORY_TO_PROFILE = { Public: 'Public', Private: 'Private', DomainAuthenticated: 'Domain' };

// facts: { interfaceAlias, profiles: [{ alias, name, category }], rules: [{ action, profile }] }
// rules = enabled inbound rules for this program.
// -> { state: 'ok' | 'blocked' | 'unknown', reason, networkName, category }
function evaluate({ interfaceAlias, profiles = [], rules = [] }) {
  const net = profiles.find((p) => p.alias === interfaceAlias) || null;
  if (!net) return { state: 'unknown', reason: 'no-network-profile', networkName: null, category: null };
  const profile = CATEGORY_TO_PROFILE[net.category] || net.category;
  const covers = (ruleProfile) => {
    const list = String(ruleProfile || '').split(',').map((s) => s.trim());
    return list.includes('Any') || list.includes(profile);
  };
  const base = { networkName: net.name || null, category: net.category };
  if (rules.some((r) => r.action === 'Block' && covers(r.profile))) return { state: 'blocked', reason: 'block-rule', ...base };
  if (rules.some((r) => r.action === 'Allow' && covers(r.profile))) return { state: 'ok', reason: 'allowed', ...base };
  return { state: 'blocked', reason: 'no-allow-rule', ...base };
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function runPowerShell(script, timeoutMs) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// Rules are matched by program path (env vars expanded, case-insensitive).
const RULES_FOR_PROGRAM = (programPath) => `
$prog = ${psQuote(programPath)}
$filters = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
  Where-Object { $_.Program -and [Environment]::ExpandEnvironmentVariables($_.Program) -ieq $prog }
`;

async function checkFirewall(programPath, interfaceAlias, { timeoutMs = 15000 } = {}) {
  if (process.platform !== 'win32') return { state: 'unknown', reason: 'not-windows', networkName: null, category: null };
  const script = `${RULES_FOR_PROGRAM(programPath)}
$rules = @($filters | Get-NetFirewallRule | Where-Object { [string]$_.Direction -eq 'Inbound' -and [string]$_.Enabled -eq 'True' } |
  ForEach-Object { @{ action = [string]$_.Action; profile = [string]$_.Profile } })
$profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue |
  ForEach-Object { @{ alias = $_.InterfaceAlias; name = $_.Name; category = [string]$_.NetworkCategory } })
ConvertTo-Json -Compress -Depth 4 @{ profiles = $profiles; rules = $rules }`;
  const r = await runPowerShell(script, timeoutMs);
  if (!r.ok) return { state: 'unknown', reason: 'check-failed', networkName: null, category: null };
  try {
    const facts = JSON.parse(r.stdout.trim() || '{}');
    return evaluate({ interfaceAlias, profiles: facts.profiles || [], rules: facts.rules || [] });
  } catch {
    return { state: 'unknown', reason: 'check-failed', networkName: null, category: null };
  }
}

// Replaces this program's inbound rules with one Allow-on-every-network rule.
// Needs admin: Windows shows its "allow this app to make changes?" prompt on
// the laptop. -> { ok } | { ok: false, cancelled } | { ok: false, error }
async function allowThroughFirewall(programPath, { timeoutMs = 120000 } = {}) {
  if (process.platform !== 'win32') return { ok: false, error: 'Only needed on Windows' };
  const elevated = `${RULES_FOR_PROGRAM(programPath)}
$filters | Get-NetFirewallRule | Where-Object { [string]$_.Direction -eq 'Inbound' } | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Foxy Timer' -Direction Inbound -Action Allow -Profile Any -Program $prog | Out-Null`;
  const encoded = Buffer.from(elevated, 'utf16le').toString('base64');
  const outer = `try {
  $p = Start-Process -FilePath ${psQuote(POWERSHELL)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'
  exit $p.ExitCode
} catch { exit 1223 }`;
  const r = await runPowerShell(outer, timeoutMs);
  if (r.ok) return { ok: true };
  if (r.code === 1223) return { ok: false, cancelled: true };
  return { ok: false, error: (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}` };
}

module.exports = { evaluate, checkFirewall, allowThroughFirewall };
