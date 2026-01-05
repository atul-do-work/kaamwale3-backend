import { StyleSheet } from 'react-native';

export default StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
    backgroundColor: '#f8fafc',
  },
  scrollContent: {
    padding: 16,
    // paddingBottom: 20,
  },

  // Welcome Section
  welcomeSection: {
    marginBottom: 4,
  },
  welcomeText: {
    fontSize: 28,
    fontWeight: '800',
    color: '#1a202c',
    marginBottom: 4,
  },

  // Grid Container
  gridContainer: {
    marginBottom: 24,
  },
  gridRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },

  // Stat Card
  statCard: {
    flex: 1,
    borderRadius: 16,
    padding: 16,
    marginHorizontal: 6,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#1a2f4d',
    shadowOpacity: 0.15,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 5,
    minHeight: 100,
    backgroundColor: '#1a2f4d',
  },
  statCardLarge: {
    minHeight: 100,
  },
  statIconContainer: {
    marginBottom: 6,
  },
  statLabel: {
    fontSize: 11,
    color: 'rgba(255, 255, 255, 0.7)',
    fontWeight: '500',
    textAlign: 'center',
    marginBottom: 6,
  },
  statValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#10b981',
    textAlign: 'center',
  },
  statValueLarge: {
    fontSize: 20,
  },

  // Summary Section
  summarySection: {
    marginBottom: 24,
  },
  summaryCard: {
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 4,
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  summaryTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
    marginLeft: 10,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryItem: {
    flex: 1,
  },
  summaryLabel: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.7)',
    fontWeight: '500',
    marginBottom: 6,
  },
  summaryValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#10b981',
  },
  summaryDivider: {
    width: 1,
    height: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    marginHorizontal: 16,
  },

  // Tips Section
  tipsSection: {
    backgroundColor: '#1a2f4d',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    borderLeftWidth: 4,
    borderLeftColor: '#20c32eff',
  },
  tipHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  tipTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ebe7e5ff',
    marginLeft: 8,
  },
  tipText: {
    fontSize: 13,
    color: '#ebe7e5ff',
    fontWeight: '500',
    marginBottom: 6,
    lineHeight: 18,
  },

  // Legacy styles (kept for compatibility)
  headerBox: {
    backgroundColor: '#000',
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  headerIcon: {
    marginRight: 12,
  },
  headerText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  bodyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  leftSide: {},
  rightSide: {},
  label: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  value: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  marginTop: {
    marginTop: 16,
  },
  box: {
    height: 200,
    backgroundColor: '#f0f0f0',
    marginBottom: 12,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
