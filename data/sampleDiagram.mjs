// Sample plan (計画) data, hand-written to exercise the data model while the
// real load/save flow (main-process IPC, file dialogs) doesn't exist yet.
// See NOTES.md "データモデル" for the shape this follows.
export const sampleDiagram = {
  line: {
    name: 'サンプル線',
    stations: [
      { id: 'A', name: 'A駅', distanceKm: 0 },
      { id: 'B', name: 'B駅', distanceKm: 5.2 },
      { id: 'C', name: 'C駅', distanceKm: 12.8 },
      { id: 'D', name: 'D駅', distanceKm: 18.0 },
    ],
  },
  trains: [
    {
      id: 'T101',
      number: '101M',
      direction: 'down', // A -> D
      stops: [
        { stationId: 'A', arrival: null, departure: '08:00:00' },
        { stationId: 'B', arrival: '08:07:30', departure: '08:08:00' },
        { stationId: 'C', arrival: '08:19:00', departure: '08:19:30' },
        { stationId: 'D', arrival: '08:27:00', departure: null },
      ],
    },
    {
      id: 'T202',
      number: '202M',
      direction: 'up', // D -> A
      stops: [
        { stationId: 'D', arrival: null, departure: '08:05:00' },
        { stationId: 'C', arrival: '08:12:30', departure: '08:13:00' },
        { stationId: 'B', arrival: '08:24:00', departure: '08:24:30' },
        { stationId: 'A', arrival: '08:32:00', departure: null },
      ],
    },
  ],
};
