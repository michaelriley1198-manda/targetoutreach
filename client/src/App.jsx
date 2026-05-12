import { Outlet, NavLink } from 'react-router-dom';

export default function App() {
  return (
    <div className="app">
      <nav className="topnav">
        <div className="brand">Target Outreach</div>
        <NavLink to="/campaigns" className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
          Campaigns
        </NavLink>
        <NavLink to="/campaigns/new" className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
          + New Campaign
        </NavLink>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
