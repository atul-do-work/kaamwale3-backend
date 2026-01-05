import { StyleSheet, Dimensions } from "react-native";

const { width } = Dimensions.get("window");

export default StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f0f2f5",
    paddingHorizontal: 12,
  },
  loadingText: {
    textAlign: "center",
    marginTop: 30,
    fontSize: 16,
    color: "#555",
  },
  noJobsText: {
    textAlign: "center",
    marginTop: 30,
    fontSize: 18,
    color: "#777",
  },
  jobCard: {
    flexDirection: "row",
    borderRadius: 16,
    overflow: "hidden",
    marginBottom: 16,
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowOffset: { width: 0, height: 3 },
    shadowRadius: 6,

  },
  leftSection: {
    flex: 1.2,
    padding: 16,
    justifyContent: "space-between",
  },
  amountText: {
    fontSize: 22,
    fontWeight: "bold",
    color: "#fff",
    marginBottom: 4,
  },
  jobTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 4,
  },
  jobDescription: {
    fontSize: 14,
    color: "#fff",
    marginBottom: 6,
  },
  locationRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 4,
  },
  locationText: {
    marginLeft: 4,
    fontSize: 14,
    color: "#fff",
    textDecorationLine: "underline",
  },
  requirementText: {
    fontSize: 12,
    color: "#ddd",
    marginTop: 4,
  },
  rightSection: {
    flex: 1,
    position: "relative",
    justifyContent: "center",
    alignItems: "center",
  },
  siteImage: {
    width: "100%",
    height: "100%",
  },
  contractorOverlay: {
    position: "absolute",
    top: 8,
    left: 8,
    backgroundColor: "rgba(97, 14, 156, 0.85)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  contractorText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  acceptButton: {
  marginTop: 10,
  backgroundColor: '#6c63ff',
  paddingVertical: 12,
  borderRadius: 12,
  alignItems: 'center',
},

buttonText: {
  color: '#fff',
  fontWeight: '600',
  fontSize: 16,
},

});
