import { StyleSheet } from 'react-native';

const styles = StyleSheet.create({
  // ------------------ Tabs ------------------
  tabRow: { flexDirection: 'row', margin: 10, borderRadius: 8, overflow: 'hidden' },
  tabButton: {
    flex: 1,
    paddingVertical: 12,
    backgroundColor: '#ddd',
    alignItems: 'center',
  },
  activeTab: { backgroundColor: '#1a2f4d' },
  tabText: { color: '#fff', fontWeight: 'bold' },

  // ------------------ Wallet Styles ------------------
  headerContainer: { paddingVertical: 20, paddingHorizontal: 15, borderRadius: 12, margin: 10 },
  headerText: { color: '#fff', fontSize: 16, marginBottom: 5 },
  amountText: { color: '#fff', fontSize: 24, fontWeight: '700' },

  balanceContainer: { backgroundColor: '#fff', padding: 15, margin: 10, borderRadius: 12 },
  balanceTitle: { fontSize: 16, color: '#333' },
  balanceAmount: { fontSize: 20, fontWeight: '600', color: '#000' },

  buttonRow: { flexDirection: 'row', justifyContent: 'space-between', margin: 10 },
  actionButton: { flex: 1, margin: 5, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: 'bold' },

  cardsRow: { flexDirection: 'row', flexWrap: 'wrap', margin: 10, justifyContent: 'space-between' },
  cardContainer: {
    backgroundColor: '#fff',
    width: '48%',
    padding: 10,
    borderRadius: 10,
    marginBottom: 10,
    alignItems: 'center',
  },
  cardAmount: { fontSize: 18, fontWeight: '600', color: '#000' },
  cardTitle: { fontSize: 14, color: '#555', marginTop: 5 },
  cardDate: { fontSize: 12, color: '#999' },

  // ------------------ Attendance Styles ------------------
  attendanceCard: {
    backgroundColor: '#fff',
    marginHorizontal: 10,
    marginVertical: 6,
    padding: 15,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 6,
    elevation: 3,
  },
  jobTitle: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  jobDescription: { fontSize: 14, color: '#555', marginBottom: 4 },
  jobAmount: { fontSize: 14, color: '#000', marginBottom: 4 },
  workerName: { fontSize: 14, color: '#333', marginBottom: 8 },
  attendanceButtons: { flexDirection: 'row', justifyContent: 'space-between' },
  presentButton: { flex: 1, marginRight: 5, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  absentButton: { flex: 1, marginLeft: 5, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },

  // ------------------ Input / Forms ------------------
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 16,
    marginVertical: 6,
    color: '#000',
  },
});

export default styles;
