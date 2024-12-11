import { eq, desc } from "drizzle-orm";
import { db } from "../db";
import { bookings, type Booking } from "@db/schema";
import type { Request, Response } from "express";
import { insertBookingSchema } from "@db/schema";

export async function createBooking(req: Request, res: Response) {
  try {
    const bookingData = insertBookingSchema.parse(req.body);
    
    // Convert stops string to array if it exists
    const stops = bookingData.stops 
      ? typeof bookingData.stops === 'string'
        ? bookingData.stops.split(',')
        : Array.isArray(bookingData.stops)
          ? bookingData.stops
          : null
      : null;
    
    // Set default values
    const booking = {
      ...bookingData,
      stops: stops ? stops : null,
      status: "pending",
      paymentStatus: "pending",
      trackingEnabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const [newBooking] = await db.insert(bookings).values(booking).returning();
    
    res.json(newBooking);
  } catch (error) {
    console.error("Failed to create booking:", error);
    res.status(400).json({ 
      error: "Failed to create booking",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
}

export async function getBooking(req: Request, res: Response) {
  try {
    const bookingId = parseInt(req.params.id);
    const booking = await db.query.bookings.findFirst({
      where: eq(bookings.id, bookingId),
    });
    
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }
    
    res.json(booking);
  } catch (error) {
    console.error("Failed to fetch booking:", error);
    res.status(500).json({ error: "Failed to fetch booking" });
  }
}

export async function getUserBookings(req: Request, res: Response) {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const userBookings = await db.query.bookings.findMany({
      where: eq(bookings.userId, req.user.id),
      orderBy: [desc(bookings.createdAt)],
    });
    
    res.json(userBookings);
  } catch (error) {
    console.error("Failed to fetch user bookings:", error);
    res.status(500).json({ error: "Failed to fetch bookings" });
  }
}
