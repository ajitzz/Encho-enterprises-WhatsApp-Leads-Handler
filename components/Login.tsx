
import React, { useState, useEffect } from 'react';
import { ShieldCheck, AlertCircle, Loader2 } from 'lucide-react';
import { liveApiService } from '../services/liveApiService';

interface LoginProps {
  onLoginSuccess: (token: string, user: any) => void;
}

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [debugUri, setDebugUri] = useState('');

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
        return;
      }

      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        onLoginSuccess(event.data.token, event.data.user);
      } else if (event.data?.type === 'OAUTH_AUTH_ERROR') {
        setError(event.data.error || 'Authentication failed');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onLoginSuccess]);

  const handleManualLogin = async () => {
    setLoading(true);
    setError('');
    try {
      const { url, redirectUri } = await liveApiService.getGoogleAuthUrl();
      setDebugUri(redirectUri);
      const width = 600;
      const height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      
      const authWindow = window.open(
        url,
        'google_oauth',
        `width=${width},height=${height},left=${left},top=${top}`
      );

      if (!authWindow) {
        setError("Popup blocked. Please allow popups for this site.");
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to initiate login.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center items-center p-4 font-sans">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-gray-200 overflow-hidden">
        
        {/* Header */}
        <div className="bg-black p-8 text-center">
          <div className="mx-auto bg-white/10 w-16 h-16 rounded-full flex items-center justify-center mb-4 backdrop-blur-md border border-white/20">
            {/* White WhatsApp Logo SVG */}
            <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor" className="text-white">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Encho WhatsApp Handler</h1>
          <p className="text-gray-400 text-sm mt-2">Administrative Dashboard Access</p>
        </div>

        {/* Body */}
        <div className="p-8">
          <div className="mb-8 text-center">
            <h2 className="text-lg font-semibold text-gray-900">Welcome Back</h2>
            <p className="text-sm text-gray-500 mt-1">Please sign in with your authorized Google Account.</p>
          </div>

          <div className="flex justify-center">
            <button
              onClick={handleManualLogin}
              disabled={loading}
              className="flex items-center gap-3 px-6 py-3 bg-white border border-gray-300 rounded-full text-gray-700 font-medium hover:bg-gray-50 transition-colors shadow-sm disabled:opacity-50"
            >
              {loading ? (
                <Loader2 size={20} className="animate-spin text-blue-600" />
              ) : (
                <svg width="18" height="18" viewBox="0 0 18 18">
                  <path fill="#4285F4" d="M17.64 9.2c0-.63-.06-1.25-.16-1.84H9v3.49h4.84c-.21 1.12-.84 2.07-1.79 2.7l2.85 2.2c1.67-1.53 2.63-3.79 2.63-6.55z"/>
                  <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.85-2.2c-.79.53-1.8.85-3.11.85-2.39 0-4.41-1.61-5.14-3.77H.95v2.35C2.43 15.99 5.48 18 9 18z"/>
                  <path fill="#FBBC05" d="M3.86 10.7c-.19-.56-.3-1.17-.3-1.8s.11-1.24.3-1.8V4.75H.95C.35 5.97 0 7.35 0 8.8s.35 2.83.95 4.05l2.91-2.15z"/>
                  <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.89 11.43 0 9 0 5.48 0 2.43 2.01.95 4.75L3.86 6.9c.73-2.16 2.75-3.77 5.14-3.77z"/>
                </svg>
              )}
              {loading ? 'Verifying...' : 'Sign in with Google'}
            </button>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mt-6 p-4 bg-red-50 border border-red-100 rounded-xl flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
              <AlertCircle size={20} className="text-red-600 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-bold text-red-900">Authentication Failed</h3>
                <p className="text-xs text-red-700 mt-1 leading-relaxed">{error}</p>
                {debugUri && (
                  <div className="mt-3 p-2 bg-white/50 rounded border border-red-200">
                    <p className="text-[10px] font-mono text-red-800 break-all">
                      Required Redirect URI:<br/>
                      {debugUri}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="mt-8 pt-6 border-t border-gray-100 flex items-center justify-center gap-2 text-xs text-gray-400">
            <ShieldCheck size={14} />
            <span>Secure Enterprise Login</span>
          </div>
        </div>
      </div>
      
      <div className="mt-8 text-center">
        <p className="text-xs text-gray-400">
          &copy; {new Date().getFullYear()} Encho Enterprises. All rights reserved.
        </p>
        <div className="flex justify-center gap-4 mt-2">
            <a href="/privacy-policy" className="text-xs text-blue-600 hover:underline">Privacy Policy</a>
            <a href="/terms" className="text-xs text-blue-600 hover:underline">Terms of Service</a>
        </div>
      </div>
    </div>
  );
};
