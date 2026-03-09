
import React, { useState } from 'react';
import { GoogleLogin, CredentialResponse } from '@react-oauth/google';
import { ShieldCheck, AlertCircle, Loader2 } from 'lucide-react';
import { liveApiService } from '../services/liveApiService';

interface LoginProps {
  onLoginSuccess: (token: string, user: any) => void;
}

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSuccess = async (credentialResponse: CredentialResponse) => {
    if (!credentialResponse.credential) {
      setError("Google Sign-In failed. No credential received.");
      return;
    }

    setLoading(true);
    setError('');

    try {
      // Send token to backend for verification against Super Admin list
      const response = await liveApiService.verifyLogin(credentialResponse.credential);
      if (response.success) {
        onLoginSuccess(credentialResponse.credential, response.user);
      } else {
        setError("Access Denied: You are not authorized to access this dashboard.");
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Server verification failed.");
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

          {loading ? (
            <div className="flex flex-col items-center justify-center py-8 space-y-4">
              <Loader2 size={32} className="animate-spin text-blue-600" />
              <p className="text-sm text-gray-500 font-medium">Verifying Credentials...</p>
            </div>
          ) : (
            <div className="flex justify-center">
              <GoogleLogin
                onSuccess={handleSuccess}
                onError={() => setError('Google Login Failed')}
                theme="outline"
                size="large"
                shape="pill"
                width="300"
              />
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="mt-6 p-4 bg-red-50 border border-red-100 rounded-xl flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
              <AlertCircle size={20} className="text-red-600 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-bold text-red-900">Authentication Failed</h3>
                <p className="text-xs text-red-700 mt-1 leading-relaxed">{error}</p>
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
