const express = require('express');
const app = express();
const cors = require('cors')
require('dotenv').config()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const port = process.env.PORT || 3000;


const admin = require("firebase-admin");

const serviceAccount = require("./zap-shift-1754b-firebase-adminsdk-fbsvc-3f8fc213ab.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


function generateTrackingId() {
  const prefix = "PKG";
  const date = new Date().toISOString().slice(0,10).replace(/-/g,""); 
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}-${date}-${random}`;
}




// middleware
app.use(cors())
app.use(express.json())


const verifyFireBaseToken = async (req, res, next) => {
    const token = req.headers.authorization;
    
    if(!token){
      return res.status(401).send({message: 'unauthorized access!'})
    }

    try {
      const idToken = token.split(' ')[1]
      const decoded = await admin.auth().verifyIdToken(idToken)
      // console.log('decoded in middleware', decoded);
      req.decoded_email = decoded.email;
      next()
      
    } catch (error) {
      return res.status(401).send({message: "unauthorized access"})
    }

    
}


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.hkduy2w.mongodb.net/?appName=Cluster0`

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});



app.get('/', (req, res) => {
    res.send('ZAP SERVER IS RUNNING...')
})


async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db('zap_shift');
    const userCollection = db.collection('users');
    const parcelCollection = db.collection('parcels');
    const paymentCollection = db.collection('payments');
    const riderCollection = db.collection('riders');
    const trackingCollection = db.collection('trackings');

    // middleware with database access
    // must use after verifyFirebaseToken 
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = {email}
      const user = await userCollection.findOne(query)
      if(!user || user.role !== 'admin'){
        return res.status(403).send({message: 'forbidden access'})
      }  
      next()
    }

    // log tracking
    const logTracking = async(trackingId, status) => {
        const log = {
          trackingId,
          status,
          details: status.split('-').join(' '),
          createdAt: new Date()
        }
        const result = await trackingCollection.insertOne(log)
        return result;
    }


    // users api
    app.post('/users', async(req, res) => {
        const user = req.body;
        user.role = 'user';
        user.createdAt = new Date();
        const email = user.email;
        const existsUser = await userCollection.findOne({email})
        if(existsUser){
          return res.send({message: 'user already exists'})
        }
        const result = await userCollection.insertOne(user)
        res.send(result)
    })

    app.get('/users', verifyFireBaseToken,  async(req, res) => {
        const searchText = req.query.searchText;
        const query = {}
        if(searchText){
          // query.displayName = {$regex: searchText, $options: 'i'};
          query.$or = [
            {displayName: {$regex: searchText, $options: 'i'}},
            {email: {$regex: searchText, $options: 'i'} }
          ]
        }
        const cursor = userCollection.find(query).sort({createdAt: -1}).limit(5)
        const result = await cursor.toArray()
        res.send(result)
    })

    app.get('/users/:id', async(req, res) => {
        
    })

    app.get('/users/:email/role', async(req, res) => {
        const email = req.params.email;
        const query = {email}
        const user = await userCollection.findOne(query)
        res.send({role: user?.role || 'user'})
    })

    app.patch('/users/:id/role', verifyFireBaseToken, verifyAdmin, async(req, res) => {
        const id = req.params.id;
        const roleInfo = req.body;
        const query = {_id: new ObjectId(id)}
        const updateRole = {
           $set: {
             role: roleInfo.role
           }
        }
        const result = await userCollection.updateOne(query, updateRole)
        res.send(result)
        
    })

    // parcels api
    app.post('/parcels', async(req, res) => {
        const parcel = req.body;
        // add date and time
        parcel.createdAt = new Date()
        const result = await parcelCollection.insertOne(parcel)
        res.send(result)
    })

    app.get('/parcels', async(req, res) => {
        const query = {}
        // /parcels?email=manik@gmail.com
        const {email, deliveryStatus} = req.query;
        if(email){
          query.senderEmail = email;
        }
        if(deliveryStatus){
          query.deliveryStatus = deliveryStatus
        }
        const options = {sort: {createdAt: -1}}
        const cursor = parcelCollection.find(query, options)
        const result = await cursor.toArray()
        res.send(result)
    })

    app.get('/parcels/rider', async(req, res) => {
        const {riderEmail, deliveryStatus} = req.query;
        const query = {}
        if(riderEmail){
          query.riderEmail = riderEmail;
        }
        if(deliveryStatus !== 'parcel-delivered'){
          // query.deliveryStatus = {$in: ['driver-assigned', 'rider-arriving']}
          query.deliveryStatus = {$nin: ['parcel-delivered']}
        }
        else {
          query.deliveryStatus = deliveryStatus
        }

        const cursor = parcelCollection.find(query)
        const result = await cursor.toArray()
        res.send(result)
    })

    app.get('/parcels/:id', async(req, res) => {
        const id = req.params.id;
        const query = {_id: new ObjectId(id)};
        const result = await parcelCollection.findOne(query)
        res.send(result)
    })

    // ToDo: rename this to specific like /parcels/:id/assign
    app.patch('/parcels/:id', async(req, res) => {
      const {riderId, riderName, riderEmail, trackingId} = req.body;
      const id = req.params.id;
      const query = {_id: new ObjectId(id)}

      const updatedDoc = {
         $set: {
            deliveryStatus: 'driver-assigned',
            riderId: riderId,
            riderName: riderName,
            riderEmail: riderEmail
         }
      }

      const result = await parcelCollection.updateOne(query, updatedDoc)

      // update rider information
      const riderQuery = {_id: new ObjectId(riderId)}
      const riderUpdateDoc = {
         $set: {
            workStatus: 'in-delivery'
         }
      }

      const riderResult = await riderCollection.updateOne(riderQuery, riderUpdateDoc)

      // log Tracking
      logTracking(trackingId, 'driver-assigned')

      res.send(riderResult)

    })

    app.patch('/parcels/:id/status', async(req, res) => {
        const {deliveryStatus, riderId, trackingId } = req.body;
        const query = {_id: new ObjectId(req.params.id)}
        const updatedDoc = {
            $set: {
                deliveryStatus: deliveryStatus
            }
        }
        if(deliveryStatus === 'parcel-delivered'){
          // update rider information
                const riderQuery = {_id: new ObjectId(riderId)}
                const riderUpdateDoc = {
                  $set: {
                      workStatus: 'available'
                  }
                }
        const riderResult = await riderCollection.updateOne(riderQuery, riderUpdateDoc)
        }
        const result = await parcelCollection.updateOne(query, updatedDoc)
        // log tracking
        logTracking(trackingId, deliveryStatus);

        res.send(result)
    })

    app.delete('/parcels/:id', async(req, res) => {
        const id = req.params.id;
        const query = {_id: new ObjectId(id)}
        const result = await parcelCollection.deleteOne(query)
        res.send(result)
    })


    // payment releted APIs
    app.post('/payment-checkout-session', async(req, res) => {
        const paymentInfo = req.body;
        const amount = parseInt(paymentInfo.cost) * 100;
        const session = await stripe.checkout.sessions.create({
          line_items: [
                {
                  price_data: {
                    currency: 'usd',
                    unit_amount: amount,
                    product_data: {
                      name: paymentInfo.parcelName
                    }
                  },
                  quantity: 1,
                },
              ],
          customer_email: paymentInfo.senderEmail,
          mode: 'payment',
          metadata: {
            parcelId: paymentInfo.parcelId,
            parcelName: paymentInfo.parcelName
          },
          success_url: `${process.env.MY_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.MY_DOMAIN}/dashboard/payment-cancelled`,
        })
        res.send({url: session.url})
    })

    // old version
    // app.post('/create-checkout-session', async(req, res) => {
    //   const paymentInfo = req.body;
    //   const amount = parseInt(paymentInfo.cost) * 100;
    //     const session = await stripe.checkout.sessions.create({
    //        line_items: [
    //           {
    //              price_data: {
    //               currency: 'USD',
    //               unit_amount: amount,
    //               product_data: {
    //                 name: paymentInfo.parcelName
    //               }
    //              },
    //             quantity: 1,
    //           },
    //         ],
    //         customer_email: paymentInfo.senderEmail,
    //         mode: 'payment',
    //         metadata: {
    //           parcelId: paymentInfo.parcelId
    //         },
    //         success_url: `${process.env.MY_DOMAIN}/dashboard/payment-success`,
    //         cancel_url: `${process.env.MY_DOMAIN}/dashboard/payment-cancelled`,
    //     })
    //     console.log(session);
    //     res.send({url: session.url})
    // })

    app.patch('/payment-success', async(req, res) => {
        const sessionId = req.query.session_id;
        const session = await stripe.checkout.sessions.retrieve(sessionId)
        // console.log('session retrive =>', session);

        const transactionId = session.payment_intent;
        const query = {transactionId: transactionId}

        const paymentExist = await paymentCollection.findOne(query)
        // console.log(paymentExist);
        if(paymentExist){
           return res.send({
            message: 'Already Exist', 
            transactionId,
            trackingId: paymentExist.trackingId
          })
        }


        const trackingId = generateTrackingId()

        if(session.payment_status === 'paid'){
           const id = session.metadata.parcelId;
           const query = {_id: new ObjectId(id)}
           const update = {
             $set: {
               paymentStatus: 'paid',
               deliveryStatus: 'pending-pickup',
               trackingId: trackingId
             }
           }
           const result = await parcelCollection.updateOne(query, update)

           const payment = {
               amount: session.amount_total / 100,
               currency: session.currency,
               customerEmail: session.customer_email,
               parcelId: session.metadata.parcelId,
               parcelName: session.metadata.parcelName,
               transactionId: session.payment_intent,
               paymentStatus: session.payment_status,
               paidAt: new Date(),
               trackingId: trackingId
           }

           if(session.payment_status === 'paid'){
              const resultPayment = await paymentCollection.insertOne(payment)

              // log tracking
              logTracking(trackingId, 'pending-pickup')

              res.send({
                 success: true,
                 trackingId: trackingId,
                 transactionId: session.payment_intent,
                 modifyParcel: result, 
                 paymentInfo: resultPayment,
                })
           }

          
        }
        res.send({success: false})
        
    })


    // payment releted apis
    app.get('/payments', verifyFireBaseToken, async(req, res) => {
        
        const email = req.query.email;
        const query = {};
        if(email){
          query.customerEmail = email;
          // check the email who has token
          if(email !== req.decoded_email){
            return res.status(403).send({message: 'forbidden access'})
          }
        }

        const cursor = paymentCollection.find(query).sort({paidAt: -1})
        const result = await cursor.toArray()
        res.send(result)

    })

    // rider api
    app.get('/riders', async(req, res) => {

      const {status, district, workStatus} = req.query;

      const query = {}

      if(status){
         query.status = status;
      }
      if(district){
        query.district = district;
      }
      if(workStatus){
        query.workStatus = workStatus
      }

      const cursor = riderCollection.find(query)
      const result = await cursor.toArray();
      res.send(result)
    })


    app.post('/riders', async(req, res) => {
        const rider = req.body;
        rider.status = 'pending';
        rider.createdAt = new Date();

        const result = await riderCollection.insertOne(rider)
        res.send(result)
    })

    app.patch('/riders/:id', verifyFireBaseToken, verifyAdmin, async(req, res) => {
        const id = req.params.id;
        const query = {_id: new ObjectId(id)}
        const status = req.body.status
        const updatedRider = {
           $set : {
             status: status,
             workStatus: 'available'
           }
        }

        const result = await riderCollection.updateOne(query, updatedRider);

        if(status === 'approved'){
          const email = req.body.email
          const userQuery = {email}
          const updateUser = {
             $set: {
                role: 'rider'
             }
          }
          const result = await userCollection.updateOne(userQuery, updateUser)
        }

        res.send(result)
    })

    // log tracking apis
    app.get('/trackings/:trackingId/logs', async(req, res) => {
        const trackingId = req.params.trackingId
        const query = {trackingId}
        const result = await trackingCollection.find(query).toArray()
        res.send(result)
    })



    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);



app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
})