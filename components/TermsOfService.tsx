
import React from 'react';
import { FileText, Mail, MapPin } from 'lucide-react';

export const TermsOfService = () => {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans text-gray-800">
      <div className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg text-white">
              <FileText size={24} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Terms of Service</h1>
          </div>
        </div>
      </div>

      <div className="flex-1 max-w-3xl mx-auto px-6 py-10 w-full">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 space-y-8">
          
          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3">1. Acceptance of Terms</h2>
            <p className="leading-relaxed text-gray-600">
              By accessing or using the WhatsApp Business services provided by <strong>Encho Cabs</strong> ("we," "our," or "us"), you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use our services.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3">2. Service Description</h2>
            <p className="leading-relaxed text-gray-600">
              Encho Cabs provides a WhatsApp-based communication channel for driver recruitment, fleet inquiries, and customer support. The service allows users to send messages, receive automated responses, and interact with our support team regarding cab services and employment opportunities.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3">3. User Responsibilities</h2>
            <p className="leading-relaxed text-gray-600 mb-2">
              When using our services, you agree to:
            </p>
            <ul className="list-disc pl-5 space-y-1 text-gray-600">
              <li>Provide accurate and truthful information (e.g., name, contact details, vehicle documents).</li>
              <li>Use the service only for lawful purposes related to cab services or recruitment.</li>
              <li>Not send spam, offensive content, or messages that violate the rights of others.</li>
              <li>Not attempt to disrupt or compromise the security of our automated systems.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3">4. Limitation of Liability</h2>
            <p className="leading-relaxed text-gray-600">
              Encho Cabs shall not be liable for any indirect, incidental, or consequential damages arising from the use or inability to use our WhatsApp services. While we strive for accuracy, automated responses may occasionally be incorrect or delayed. We reserve the right to modify or discontinue the service at any time without notice.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3">5. Governing Law</h2>
            <p className="leading-relaxed text-gray-600">
              These Terms shall be governed by and construed in accordance with the laws of India. Any disputes arising under these Terms shall be subject to the exclusive jurisdiction of the courts located in Bengaluru, Karnataka.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3">6. Contact Information</h2>
            <p className="leading-relaxed text-gray-600 mb-4">
              For any questions regarding these Terms of Service, please contact us at:
            </p>
            
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-100 space-y-3">
              <div className="flex items-center gap-3 text-sm text-gray-700">
                <Mail size={18} className="text-blue-600" />
                <a href="mailto:enchoenterprises@gmail.com" className="hover:text-blue-600 font-medium">enchoenterprises@gmail.com</a>
              </div>
              <div className="flex items-center gap-3 text-sm text-gray-700">
                <MapPin size={18} className="text-blue-600" />
                <span>Electronic City, Bengaluru</span>
              </div>
            </div>
          </section>

          <div className="pt-6 border-t border-gray-100 text-xs text-gray-400 text-center">
            Last Updated: {new Date().toLocaleDateString()}
          </div>

        </div>
      </div>
    </div>
  );
};
