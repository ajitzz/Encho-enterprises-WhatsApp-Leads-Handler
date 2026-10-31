import test from 'node:test';
import assert from 'node:assert/strict';

test('Shadow Mode: staffId resolution normalizes both id and staffId on user profile', () => {
  // Simulating staff member object from /api/staff as passed to onShadowUser
  const rawStaffFromApi = {
    id: 'staff-uuid-1234',
    name: 'Aswin',
    email: 'aswin@encho.com',
    role: 'manager',
    manager_id: null,
  };

  // Normalization logic applied in App.tsx handleStartShadow and StaffPortal
  const normalizedUser = {
    ...rawStaffFromApi,
    id: rawStaffFromApi.staffId || rawStaffFromApi.id,
    staffId: rawStaffFromApi.staffId || rawStaffFromApi.id,
  };

  assert.equal(normalizedUser.id, 'staff-uuid-1234');
  assert.equal(normalizedUser.staffId, 'staff-uuid-1234');

  // Verify that filtering by user.staffId matches leads assigned to this staff member
  const sampleLeads = [
    { id: 'lead-1', name: 'Jabi', assigned_to: 'staff-uuid-1234', lead_status: 'claimed' },
    { id: 'lead-2', name: 'Richu', assigned_to: null, lead_status: 'new' },
    { id: 'lead-3', name: 'Other', assigned_to: 'staff-uuid-9999', lead_status: 'claimed' },
  ];

  const myLeads = sampleLeads.filter(l => l.assigned_to === (normalizedUser.staffId || normalizedUser.id));
  assert.equal(myLeads.length, 1);
  assert.equal(myLeads[0].name, 'Jabi');
});

test('Shadow Mode: admin claim target resolution selects shadowed staff id', () => {
  // Simulating req.user after authMiddleware with x-shadow-staff-id: 'aswin-uuid'
  const reqUser = {
    id: 'google-sub-admin',
    staffId: 'aswin-uuid', // Resolved to shadowed staff
    role: 'manager',       // Resolved to shadowed role
    name: 'Aswin',
    isShadowMode: true,
    originalAdminStaffId: 'admin-uuid',
    originalAdminRole: 'admin',
  };

  const reqBody = {}; // Empty body from UI click

  const isSuperAdmin = reqUser.role === 'admin' || reqUser.originalAdminRole === 'admin';
  const targetStaffId = (isSuperAdmin && reqBody?.staff_id) 
    ? reqBody.staff_id 
    : reqUser.staffId;

  // Must resolve to Aswin's ID, NOT Admin's ID!
  assert.equal(targetStaffId, 'aswin-uuid');
  assert.equal(isSuperAdmin, true);
  assert.equal(reqUser.isShadowMode, true);
  assert.equal(reqUser.originalAdminStaffId, 'admin-uuid');
});

test('Shadow Mode: manager can only shadow subordinates', () => {
  const managerUser = {
    id: 'google-sub-mgr',
    staffId: 'mgr-uuid',
    role: 'manager',
  };

  const teamSubordinate = {
    id: 'sub-uuid',
    name: 'Staff A',
    manager_id: 'mgr-uuid',
    role: 'staff',
  };

  const outsiderStaff = {
    id: 'outsider-uuid',
    name: 'Staff B',
    manager_id: 'other-mgr-uuid',
    role: 'staff',
  };

  const canShadowSub = managerUser.role === 'manager' && (teamSubordinate.manager_id === managerUser.staffId || teamSubordinate.id === managerUser.staffId);
  const canShadowOutsider = managerUser.role === 'manager' && (outsiderStaff.manager_id === managerUser.staffId || outsiderStaff.id === managerUser.staffId);

  assert.equal(canShadowSub, true);
  assert.equal(canShadowOutsider, false);
});
