export type VehicleKind = 'car' | 'truck' | 'tank' | 'moto' | 'bicycle' | 'hover' | 'boat' | 'jetski' | 'sub' | 'heli' | 'plane' | 'jet';
export type Domain = 'land' | 'water' | 'air';

export interface VehicleDef {
  id: string;
  name: string;
  model: string;
  kind: VehicleKind;
  domain: Domain;
  seats: number;
  maxSpeed: number; // m/s
  accel: number; // m/s² equivalent
  mass: number;
  health: number;
  /** wheel layout overrides (fraction of half-extents) */
  wheelInset?: number;
  weapon?: 'cannon' | 'mg' | 'rockets' | 'none';
  camDist?: number;
  armored?: boolean;
}

const V = (d: Partial<VehicleDef> & Pick<VehicleDef, 'id' | 'name' | 'model' | 'kind'>): VehicleDef => ({
  domain: ['boat', 'jetski', 'sub'].includes(d.kind) ? 'water' : ['heli', 'plane', 'jet'].includes(d.kind) ? 'air' : 'land',
  seats: 4, maxSpeed: 38, accel: 9, mass: 1300, health: 900, weapon: 'none', camDist: 7, ...d,
});

export const VEHICLES: Record<string, VehicleDef> = Object.fromEntries([
  V({ id: 'car_sedan', name: 'Sedan', model: 'car_sedan', kind: 'car' }),
  V({ id: 'car_hatch', name: 'Hatchback', model: 'car_hatch', kind: 'car', maxSpeed: 35 }),
  V({ id: 'car_suv', name: 'SUV', model: 'car_suv', kind: 'car', maxSpeed: 36, mass: 1900, health: 1200 }),
  V({ id: 'car_sport', name: 'Sportwagen', model: 'car_sport', kind: 'car', maxSpeed: 52, accel: 13, seats: 2 }),
  V({ id: 'car_sport2', name: 'Coupé', model: 'car_sport2', kind: 'car', maxSpeed: 50, accel: 12, seats: 2 }),
  V({ id: 'car_taxi', name: 'Taxi', model: 'car_taxi', kind: 'car' }),
  V({ id: 'car_cop', name: 'Streifenwagen', model: 'car_cop', kind: 'car', maxSpeed: 46, accel: 11 }),
  V({ id: 'car_police', name: 'Interceptor', model: 'car_police', kind: 'car', maxSpeed: 47, accel: 11 }),
  V({ id: 'car_classic', name: 'Classic 53', model: 'car_classic', kind: 'car', maxSpeed: 34, mass: 1900 }),
  V({ id: 'car_muscle', name: 'Muscle Car', model: 'car_muscle', kind: 'car', maxSpeed: 49, accel: 12, seats: 2 }),
  V({ id: 'car_roadster', name: 'Roadster', model: 'car_roadster', kind: 'car', maxSpeed: 48, accel: 12, seats: 2 }),
  V({ id: 'jeep', name: 'Jeep', model: 'jeep', kind: 'car', maxSpeed: 34, accel: 10, health: 1100 }),
  V({ id: 'truck', name: 'Sattelzug', model: 'truck', kind: 'truck', maxSpeed: 28, accel: 5, mass: 8000, health: 2500, seats: 2, camDist: 14 }),
  V({ id: 'bus', name: 'Bus', model: 'bus', kind: 'truck', maxSpeed: 26, accel: 5, mass: 7000, health: 2200, seats: 8, camDist: 13 }),
  V({ id: 'tractor', name: 'Traktor', model: 'tractor', kind: 'car', maxSpeed: 16, accel: 6, mass: 2500, seats: 1 }),
  V({ id: 'golfcart', name: 'Golfcart', model: 'golfcart', kind: 'car', maxSpeed: 15, accel: 6, mass: 500, seats: 2, health: 400 }),
  V({ id: 'tank', name: 'Kampfpanzer', model: 'tank', kind: 'tank', maxSpeed: 15, accel: 4, mass: 30000, health: 6000, seats: 2, weapon: 'cannon', camDist: 11, armored: true }),
  V({ id: 'apc', name: 'Radpanzer', model: 'apc', kind: 'truck', maxSpeed: 24, accel: 5, mass: 14000, health: 4000, seats: 6, weapon: 'mg', camDist: 11, armored: true }),
  V({ id: 'motorcycle', name: 'Motorrad', model: 'motorcycle', kind: 'moto', maxSpeed: 50, accel: 14, mass: 260, seats: 2, health: 450, camDist: 5 }),
  V({ id: 'bicycle', name: 'Fahrrad', model: 'bicycle', kind: 'bicycle', maxSpeed: 12, accel: 5, mass: 30, seats: 1, health: 150, camDist: 4.5 }),
  V({ id: 'hovercar', name: 'Hovercar', model: 'hovercar', kind: 'hover', maxSpeed: 42, accel: 12, mass: 900, seats: 2, health: 700 }),
  V({ id: 'jetski', name: 'Jetski', model: 'jetski', kind: 'jetski', maxSpeed: 26, accel: 11, mass: 350, seats: 2, health: 400, camDist: 5 }),
  V({ id: 'speedboat', name: 'Speedboot', model: 'speedboat', kind: 'boat', maxSpeed: 30, accel: 8, mass: 1500, seats: 6, health: 1100, camDist: 10 }),
  V({ id: 'boat', name: 'Motorboot', model: 'boat', kind: 'boat', maxSpeed: 18, accel: 6, mass: 600, seats: 4, health: 600 }),
  V({ id: 'submarine', name: 'U-Boot', model: 'submarine', kind: 'sub', maxSpeed: 14, accel: 3, mass: 20000, seats: 4, health: 3000, camDist: 18 }),
  V({ id: 'heli_huey', name: 'Transport-Heli', model: 'heli_huey', kind: 'heli', maxSpeed: 55, accel: 10, mass: 4000, seats: 6, health: 1800, weapon: 'mg', camDist: 16 }),
  V({ id: 'heli_apache', name: 'Kampfhubschrauber', model: 'heli_apache', kind: 'heli', maxSpeed: 65, accel: 12, mass: 5000, seats: 2, health: 2600, weapon: 'rockets', camDist: 17, armored: true }),
  V({ id: 'heli_small', name: 'Rettungs-Heli', model: 'heli_small', kind: 'heli', maxSpeed: 60, accel: 12, mass: 1500, seats: 4, health: 1200, camDist: 13 }),
  V({ id: 'plane_prop', name: 'Propellerflugzeug', model: 'plane_prop', kind: 'plane', maxSpeed: 75, accel: 12, mass: 1000, seats: 2, health: 900, camDist: 14 }),
  V({ id: 'jet_f16', name: 'Kampfjet', model: 'jet_f16', kind: 'jet', maxSpeed: 170, accel: 30, mass: 9000, seats: 1, health: 2000, weapon: 'rockets', camDist: 20, armored: true }),
].map((v) => [v.id, v]));
