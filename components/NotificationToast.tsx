
import React, { useEffect } from 'react';
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react';
import { AppNotification } from '../types';

interface NotificationToastProps {
  notifications: AppNotification[];
  onDismiss: (id: string) => void;
}

export const NotificationToast: React.FC<NotificationToastProps> = ({ notifications, onDismiss }) => {
  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-3 pointer-events-none">
      {notifications.map((notif) => (
        <div 
          key={notif.id}
          className={`
            pointer-events-auto w-80 bg-white rounded-lg shadow-lg border-l-4 p-4 transform transition-all animate-in slide-in-from-right
            ${notif.type === 'success' ? 'border-green-500' : ''}
            ${notif.type === 'warning' ? 'border-amber-500' : ''}
            ${notif.type === 'info' ? 'border-blue-500' : ''}
          `}
        >
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 pt-0.5">
              {notif.type === 'success' && <CheckCircle size={18} className="text-green-500" />}
              {notif.type === 'warning' && <AlertCircle size={18} className="text-amber-500" />}
              {notif.type === 'info' && <Info size={18} className="text-blue-500" />}
            </div>
            <div className="flex-1">
              <h4 className="text-sm font-semibold text-gray-900">{notif.title}</h4>
              <p className="text-sm text-gray-500 mt-1">{notif.message}</p>
            </div>
            <button 
              onClick={() => onDismiss(notif.id)}
              className="text-gray-400 hover:text-gray-600"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
