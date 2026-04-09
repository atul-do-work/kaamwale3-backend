/**
 * Upload Telemetry & Logging Service
 * For production debugging and monitoring
 */
import { LogLevel } from './uploadConfig';

interface UploadLog {
  timestamp: string;
  level: LogLevel;
  message: string;
  metadata?: Record<string, any>;
  uploadId: string;
}

class UploadTelemetry {
  private logs: UploadLog[] = [];
  private maxLogs = 100; // Keep only last 100 logs
  private uploadStartTimes: Map<string, number> = new Map();

  /**
   * Log an upload event
   */
  log(
    uploadId: string,
    level: LogLevel,
    message: string,
    metadata?: Record<string, any>
  ) {
    const log: UploadLog = {
      timestamp: new Date().toISOString(),
      level,
      message,
      metadata,
      uploadId,
    };

    this.logs.push(log);

    // Keep only last N logs
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Also log to console in debug mode
    if (__DEV__) {
      const consoleMethod = this.getConsoleMethod(level);
      consoleMethod(
        `[${uploadId}] ${message}`,
        metadata || ''
      );
    }
  }

  /**
   * Record upload start time for duration tracking
   */
  recordStart(uploadId: string) {
    this.uploadStartTimes.set(uploadId, Date.now());
  }

  /**
   * Get upload duration in milliseconds
   */
  getDuration(uploadId: string): number {
    const startTime = this.uploadStartTimes.get(uploadId);
    if (!startTime) return 0;
    return Date.now() - startTime;
  }

  /**
   * Get all logs for an upload
   */
  getLogsForUpload(uploadId: string): UploadLog[] {
    return this.logs.filter((log) => log.uploadId === uploadId);
  }

  /**
   * Get all logs
   */
  getAllLogs(): UploadLog[] {
    return [...this.logs];
  }

  /**
   * Clear logs
   */
  clearLogs() {
    this.logs = [];
    this.uploadStartTimes.clear();
  }

  /**
   * Export logs for debugging
   */
  exportLogs(): string {
    return JSON.stringify(this.logs, null, 2);
  }

  /**
   * Send logs to backend for analysis (optional)
   */
  async sendToBackend(apiEndpoint: string, token: string) {
    try {
      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          logs: this.logs,
          timestamp: new Date().toISOString(),
        }),
      });

      if (response.ok) {
        console.log('✅ Upload telemetry sent to backend');
        // Optionally clear logs after sending
        // this.clearLogs();
      }
    } catch (error) {
      console.error('Failed to send upload telemetry:', error);
    }
  }

  /**
   * Get console method based on log level
   */
  private getConsoleMethod(level: LogLevel) {
    switch (level) {
      case LogLevel.DEBUG:
        return console.debug;
      case LogLevel.INFO:
        return console.log;
      case LogLevel.WARN:
        return console.warn;
      case LogLevel.ERROR:
        return console.error;
      default:
        return console.log;
    }
  }
}

export const uploadTelemetry = new UploadTelemetry();
