
import React, { useState } from 'react';
import { GoogleLogin, CredentialResponse } from '@react-oauth/google';
import { Car, ShieldCheck, Lock } from 'lucide-react';
import { jwtDecode } from "jwt-decode";
import { liveApiService } from '../services/liveApiService';

interface LoginProps {
  onLoginSuccess: (user: any) => void;
}

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleGoogleSuccess = async (credentialResponse: CredentialResponse) => {
    setIsLoading(true);
    setError(null);
    
    if (credentialResponse.credential) {
      try {
        // 1. Verify with Backend (Strict Check)
        const response = await liveApiService.verifyToken(credentialResponse.credential);
        
        if (response.success) {
            // 2. Decode for local UI
            const decoded: any = jwtDecode(credentialResponse.credential);
            
            // 3. Save Session
            localStorage.setItem('auth_token', credentialResponse.credential);
            localStorage.setItem('user_profile', JSON.stringify({
                name: decoded.name,
                email: decoded.email,
                picture: decoded.picture
            }));

            // 4. Notify App
            onLoginSuccess({
                name: decoded.name,
                email: decoded.email,
                picture: decoded.picture
            });
        } else {
            setError(response.error || "Authentication failed on server.");
        }
      } catch (err: any) {
        console.error("Login Error", err);
        setError(err.message || "Failed to verify credentials.");
      } finally {
        setIsLoading(false);
      }
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-gray-200 overflow-hidden">
        
        {/* Header */}
        <div className="bg-black p-8 text-center">
          <div className="mx-auto bg-white w-14 h-14 rounded-full flex items-center justify-center mb-4 shadow-lg">
            <Car size={28} className="text-black" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Uber Fleet Recruiter</h1>
          <p className="text-gray-400 text-sm mt-2">Authorized Personnel Only</p>
        </div>

        {/* Body */}
        <div className="p-8">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-50 text-blue-600 mb-4">
              <ShieldCheck size={24} />
            </div>
            <h2 className="text-lg font-bold text-gray-900">Secure Dashboard Access</h2>
            <p className="text-sm text-gray-500 mt-1">
              Please sign in with your corporate Google account to access the command center.
            </p>
          </div>

          <div className="flex justify-center mb-6">
            {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                    <div className="w-4 h-4 border-2 border-gray-300 border-t-black rounded-full animate-spin"></div>
                    Verifying credentials...
                </div>
            ) : (
                <div className="w-full flex justify-center">
                    <GoogleLogin
                        onSuccess={handleGoogleSuccess}
                        onError={() => setError("Google Login Failed")}
                        theme="filled_black"
                        shape="pill"
                        width="300"
                    />
                </div>
            )}
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 p-3 rounded-lg text-xs flex items-center gap-2 border border-red-100 animate-in fade-in slide-in-from-top-2">
              <Lock size={14} />
              <span className="font-medium">{error}</span>
            </div>
          )}

          <div className="mt-8 pt-6 border-t border-gray-100 text-center">
            <p className="text-[10px] text-gray-400 uppercase font-bold tracking-widest">
              Encho Enterprises &copy; {new Date().getFullYear()}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
