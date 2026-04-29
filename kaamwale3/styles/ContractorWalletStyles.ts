import { StyleSheet } from 'react-native';

const styles = StyleSheet.create({
  // ------------------ Tabs ------------------
  tabRow: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 6,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#e9edf2',
    padding: 4,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: 'transparent',
    alignItems: 'center',
  },
  activeTab: { backgroundColor: '#17263A' },
  tabText: { color: '#5b6472', fontWeight: '700', fontSize: 14 },
  activeTabText: { color: '#ffffff' },

  // ------------------ Wallet Styles ------------------
  headerContainer: {
    paddingVertical: 24,
    paddingHorizontal: 18,
    borderRadius: 24,
    marginHorizontal: 16,
    marginTop: 6,
    marginBottom: 4,
  },
  headerText: { color: 'rgba(255,255,255,0.78)', fontSize: 13, marginBottom: 6, fontWeight: '600' },
  amountText: { color: '#fff', fontSize: 30, fontWeight: '700' },

  balanceContainer: {
    backgroundColor: '#fff',
    paddingVertical: 18,
    paddingHorizontal: 18,
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#e8edf3',
  },
  balanceTitle: { fontSize: 13, color: '#6b7280', fontWeight: '600', marginBottom: 6 },
  balanceAmount: { fontSize: 24, fontWeight: '700', color: '#111827' },

  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 0,
  },
  actionButton: {
    flex: 1,
    marginHorizontal: 4,
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: 'center',
  },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  cardsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: 16,
    marginTop: 14,
    justifyContent: 'space-between',
  },
  cardContainer: {
    backgroundColor: '#fff',
    width: '48%',
    paddingVertical: 18,
    paddingHorizontal: 14,
    borderRadius: 20,
    marginBottom: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e8edf3',
  },
  cardAmount: { fontSize: 20, fontWeight: '700', color: '#17263A', marginTop: 2 },
  cardTitle: { fontSize: 13, color: '#374151', marginTop: 8, fontWeight: '600' },
  cardDate: { fontSize: 11, color: '#9ca3af', marginTop: 4 },

  // ------------------ Attendance Styles ------------------
  attendanceCard: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginVertical: 6,
    padding: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#e8edf3',
  },
  jobTitle: { fontSize: 16, fontWeight: '700', marginBottom: 4, color: '#111827' },
  jobDescription: { fontSize: 14, color: '#6b7280', marginBottom: 4 },
  jobAmount: { fontSize: 14, color: '#111827', marginBottom: 4, fontWeight: '600' },
  workerName: { fontSize: 14, color: '#374151', marginBottom: 8 },
  attendanceButtons: { flexDirection: 'row', justifyContent: 'space-between' },
  presentButton: { flex: 1, marginRight: 5, paddingVertical: 10, borderRadius: 12, alignItems: 'center' },
  absentButton: { flex: 1, marginLeft: 5, paddingVertical: 10, borderRadius: 12, alignItems: 'center' },

  // ------------------ Input / Forms ------------------
  input: {
    borderWidth: 1,
    borderColor: '#d8dee6',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 12,
    fontSize: 15,
    marginVertical: 6,
    color: '#111827',
    backgroundColor: '#fff',
  },
});

export default styles;
