export interface SystemHealth {
  status: 'ok' | 'degraded' | 'down';
  timestamp: number;
  dependencies: Record<string, string>;
  degradedReasons: string[];
}
