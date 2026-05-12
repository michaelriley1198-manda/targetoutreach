import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import App from './App.jsx';
import CampaignList from './pages/CampaignList.jsx';
import CampaignDetail from './pages/CampaignDetail.jsx';
import NewCampaign from './pages/NewCampaign.jsx';
import DialSession from './pages/DialSession.jsx';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<Navigate to="/campaigns" replace />} />
          <Route path="campaigns" element={<CampaignList />} />
          <Route path="campaigns/new" element={<NewCampaign />} />
          <Route path="campaigns/:id" element={<CampaignDetail />} />
          <Route path="campaigns/:id/dial" element={<DialSession />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
