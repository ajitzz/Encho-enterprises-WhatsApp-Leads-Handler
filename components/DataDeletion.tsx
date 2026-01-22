
import React from 'react';
import { Trash2, Mail, CheckCircle } from 'lucide-react';

export const DataDeletion = () => {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans text-gray-800">
      <div className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="bg-red-600 p-2 rounded-lg text-white">
              <Trash2 size={24} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">User Data Deletion Instructions</h1>
          </div>
        </div>
      </div>

      <div className="flex-1 max-w-3xl mx-auto px-6 py-10 w-full">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 space-y-8">
          
          <section>
            <p className="leading-relaxed text-gray-600 text-lg">
              <strong>Encho Cabs</strong> values your privacy. According to the Facebook Platform Policy, we provide a way for users to request that their data be deleted from our systems.
            </p>
          </section>

          <section className="bg-blue-50 border border-blue-100 rounded-xl p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-4">How to Request Data Deletion</h2>
            <p className="text-gray-600 mb-4">
              If you wish to remove your message history, contact details, and submitted documents from our database, please follow these steps:
            </p>
            
            <div className="space-y-4">
              <div className="flex gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold">1</div>
                <div>
                  <h3 className="font-bold text-gray-900">Send an Email Request</h3>
                  <p className="text-sm text-gray-600 mt-1">
                    Email our privacy team at <a href="mailto:enchoenterprises@gmail.com" className="text-blue-600 font-medium underline">enchoenterprises@gmail.com</a>.
                  </p>
                </div>
              </div>

              <div className="flex gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold">2</div>
                <div>
                  <h3 className="font-bold text-gray-900">Include Your Details</h3>
                  <p className="text-sm text-gray-600 mt-1">
                    Please use the subject line <strong>"Data Deletion Request"</strong> and include the phone number you used to contact us on WhatsApp.
                  </p>
                </div>
              </div>

              <div className="flex gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold">3</div>
                <div>
                  <h3 className="font-bold text-gray-900">Confirmation</h3>
                  <p className="text-sm text-gray-600 mt-1">
                    We will process your request and permanently delete your data within <strong>30 days</strong>. You will receive a confirmation email once the process is complete.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-bold text-gray-900 mb-3">Types of Data Deleted</h2>
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <li className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 p-2 rounded border border-gray-100">
                    <CheckCircle size={16} className="text-green-500" /> WhatsApp Chat History
                </li>
                <li className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 p-2 rounded border border-gray-100">
                    <CheckCircle size={16} className="text-green-500" /> Phone Number & Name
                </li>
                <li className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 p-2 rounded border border-gray-100">
                    <CheckCircle size={16} className="text-green-500" /> Submitted Documents (Licenses/RC)
                </li>
                <li className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 p-2 rounded border border-gray-100">
                    <CheckCircle size={16} className="text-green-500" /> Application Status
                </li>
            </ul>
          </section>

        </div>
      </div>
    </div>
  );
};
