
import React from 'react';
import { Shield, Mail, MapPin } from 'lucide-react';

export const PrivacyPolicy = () => {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans text-gray-800">
      <div className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg text-white">
              <Shield size={24} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Privacy Policy</h1>
          </div>
        </div>
      </div>

      <div className="flex-1 max-w-3xl mx-auto px-6 py-10 w-full">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 space-y-8">
          
          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3">1. Introduction</h2>
            <p className="leading-relaxed text-gray-600">
              Welcome to <strong>Encho Cabs</strong> ("we," "our," or "us"). We are committed to protecting your privacy and ensuring the security of your personal information. This Privacy Policy explains how we collect, use, and protect the data you share with us through our WhatsApp Business services and recruitment platforms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3">2. Information We Collect</h2>
            <p className="leading-relaxed text-gray-600 mb-2">
              We collect information necessary to provide our services, manage inquiries, and facilitate driver recruitment. This includes:
            </p>
            <ul className="list-disc pl-5 space-y-1 text-gray-600">
              <li><strong>Contact Information:</strong> Phone number, profile name (as visible on WhatsApp).</li>
              <li><strong>Communication Data:</strong> Message history, inquiries, and support requests sent via WhatsApp.</li>
              <li><strong>Documents:</strong> Driving licenses, ID proofs, and vehicle registration documents provided voluntarily for verification purposes.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3">3. How We Use Your Information</h2>
            <p className="leading-relaxed text-gray-600 mb-2">
              We use the collected data for the following specific purposes:
            </p>
            <ul className="list-disc pl-5 space-y-1 text-gray-600">
              <li><strong>Customer Support:</strong> To respond to your queries and resolve issues.</li>
              <li><strong>Inquiries & Bookings:</strong> To process service requests and vehicle bookings.</li>
              <li><strong>Recruitment:</strong> To verify driver eligibility and onboard new fleet members.</li>
              <li><strong>Service Updates:</strong> To send important notifications regarding your engagement with Encho Cabs.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3">4. Data Retention</h2>
            <p className="leading-relaxed text-gray-600">
              We retain your message history and personal data for a period of <strong>1 year</strong> or until the relevant inquiry/issue is fully resolved, whichever is later. After this period, data is securely deleted or anonymized, unless required by law for legal or tax purposes.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3">5. Data Sharing</h2>
            <p className="leading-relaxed text-gray-600">
              We do not sell your personal data. We may share data with:
            </p>
            <ul className="list-disc pl-5 space-y-1 text-gray-600 mt-2">
              <li><strong>Meta Platforms, Inc. (WhatsApp):</strong> As our communication service provider.</li>
              <li><strong>Legal Authorities:</strong> If required by law to comply with a legal obligation or protect our rights.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3">6. Contact Us</h2>
            <p className="leading-relaxed text-gray-600 mb-4">
              If you have questions about this Privacy Policy or wish to request the deletion of your data, please contact us at:
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
