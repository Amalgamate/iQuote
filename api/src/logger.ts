/**
 * Structured logger — outputs JSON to stdout for Docker/container log capture.
 *
 * Every log entry includes: timestamp, level, message, requestId.
 * Optional fields: userId, organisationId, meta (arbitrary structured data).
 *
 * iQuote never logs sensitive data (passwords, tokens, session hashes, MFA secrets).
 */

type LogLevel = 'info' | 'error' | 'warn'

interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  requestId?: string
  userId?: string
  organisationId?: string
  meta?: Record<string, unknown>
}

function writeLog(level: LogLevel, message: string, context?: {
  requestId?: string
  userId?: string
  organisationId?: string
  meta?: Record<string, unknown>
}) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
  }
  if (context?.requestId) entry.requestId = context.requestId
  if (context?.userId) entry.userId = context.userId
  if (context?.organisationId) entry.organisationId = context.organisationId
  if (context?.meta) entry.meta = context.meta

  const json = JSON.stringify(entry)
  if (level === 'error') {
    process.stdout.write(json + '\n')
  } else if (level === 'warn') {
    process.stdout.write(json + '\n')
  } else {
    process.stdout.write(json + '\n')
  }
}

export function logInfo(message: string, context?: { requestId?: string; userId?: string; organisationId?: string; meta?: Record<string, unknown> }) {
  writeLog('info', message, context)
}

export function logError(message: string, context?: { requestId?: string; userId?: string; organisationId?: string; meta?: Record<string, unknown> }) {
  writeLog('error', message, context)
}

export function logWarn(message: string, context?: { requestId?: string; userId?: string; organisationId?: string; meta?: Record<string, unknown> }) {
  writeLog('warn', message, context)
}
