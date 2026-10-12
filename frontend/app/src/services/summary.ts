// Trainee daily performance summary — computed by the trainee Lambda from the
// caller's own scored sessions (JWT-scoped) plus anonymised cohort averages.

import { apiRequest } from './api';
import type { DailySummary } from '../types';

/**
 * Get the summary for the local calendar day containing `date`.
 * The day boundaries are computed in the browser so "today" follows the
 * trainee's timezone.
 */
export const getDailySummary = async (date: Date): Promise<DailySummary> => {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return apiRequest<DailySummary>('/me/summary', {
    queryParams: { start: start.toISOString(), end: end.toISOString() },
  });
};
