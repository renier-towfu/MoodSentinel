import { useState, useCallback, useRef } from 'react';
import { analyzePost } from '../services/api';

export function useAnalysis() {
  const [status, setStatus] = useState('idle');
  const [error,  setError]  = useState(null);
  const [result, setResult] = useState(null);
  const isRunning = useRef(false);

  const run = useCallback(async (postUrl, cookies = '') => {
    setStatus('loading');
    setError(null);
    setResult(null);
    try {
      const data = await analyzePost(postUrl, cookies);
      setStatus('idle');
      return data;
    } catch (err) {
      setError(err.message);
      setStatus('error');
      throw err;
    }
  }, []);

  const runInBackground = useCallback(async (postUrl, cookies = '') => {
    if (isRunning.current) return false;
    isRunning.current = true;
    setStatus('loading');
    setError(null);
    setResult(null);

    analyzePost(postUrl, cookies)
      .then(data => {
        setResult(data);
        setStatus('done');
        isRunning.current = false;
      })
      .catch(err => {
        setError(err.message);
        setStatus('error');
        isRunning.current = false;
      });

    return true;
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
    setResult(null);
    isRunning.current = false;
  }, []);

  return {
    status,
    error,
    result,
    run,
    runInBackground,
    reset,
    isLoading: status === 'loading',
    isDone:    status === 'done',
    isBlocked: isRunning.current,
  };
}