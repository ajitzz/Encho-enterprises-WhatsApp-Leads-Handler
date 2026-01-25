
import React, { useState } from 'react';
import { GoogleLogin, CredentialResponse } from '@react-oauth/google';
import { Car, ShieldCheck, AlertCircle, Loader2 } from 'lucide-react';
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
            <Car size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Uber Fleet Recruiter</h1>
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
